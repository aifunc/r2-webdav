import { DEAD_PROPERTY_PREFIX } from '../../shared/constants';
import {
	acquireResourceMutationGuard,
	createGuardAwareBucket,
	LockMutationGuardLostError,
	assertLockPermission,
	assertNoDescendantLockConflicts,
	determineLockDepth,
	findMatchingLock,
	getLockDetails,
	getLockDiscovery,
	hasLockScopeConflict,
	normalizeLockToken,
	parseTimeout,
	getPreservedCustomMetadata,
	getRequestLockTokensForTarget,
	stripLockMetadata,
	upsertLockDetails,
	withLockMetadata,
	readLockState,
} from '../../domain/locks';
import {
	getParentPath,
	getResourceHref,
	hasTrailingSlashPath,
	isCollectionObject,
	makeResourcePath,
} from '../../domain/path';
import { hasCollectionResourceOrImplicit, rewriteStoredObject } from '../../domain/storage';
import { DEFAULT_SIDECAR_CONFIG } from '../../shared/sidecar';
import type { DirectorySidecar, LockDetails, SidecarConfig } from '../../shared/types';
import {
	getDirectorySidecarKey,
	legacyMarkerToSidecar,
	readDirectorySidecarState,
	readLegacyDirectoryMarker,
	updateDirectorySidecar,
} from '../../domain/directories';
import { createTextResponse, normalizeDepthHeader, readXmlBodyWithLimit, xmlResponse } from '../responses';
import { parseLockRequest } from '../xml';

function stripDirectoryMetadata(customMetadata: Record<string, string> | undefined): Record<string, string> {
	let metadata = stripLockMetadata(customMetadata);
	for (const key of Object.keys(metadata)) {
		if (key.startsWith(DEAD_PROPERTY_PREFIX)) {
			delete metadata[key];
		}
	}
	return metadata;
}

export async function handleLock(
	request: Request,
	bucket: R2Bucket,
	sidecarConfig: SidecarConfig = DEFAULT_SIDECAR_CONFIG,
	mutationGuard?: DurableObjectNamespace,
): Promise<Response> {
	let resourcePath = makeResourcePath(request);
	let guard = await acquireResourceMutationGuard(bucket, resourcePath, sidecarConfig, mutationGuard);
	if (guard === 'capacity') {
		return createTextResponse('unavailable');
	}
	if (guard === null) {
		return createTextResponse('locked');
	}
	if (guard.isLost()) {
		await guard.release();
		return createTextResponse('unavailable');
	}
	let guardedBucket = createGuardAwareBucket(bucket, guard);
	try {
		return await acquireLock(request, guardedBucket, sidecarConfig);
	} catch (error) {
		if (error instanceof LockMutationGuardLostError) {
			return createTextResponse('unavailable');
		}
		throw error;
	} finally {
		await guard.release();
	}
}

async function acquireLock(request: Request, bucket: R2Bucket, sidecarConfig: SidecarConfig): Promise<Response> {
	let resourcePath = makeResourcePath(request);
	let rawDepthHeader = request.headers.get('Depth');
	let depthHeader = rawDepthHeader === null ? null : normalizeDepthHeader(rawDepthHeader);
	if (depthHeader !== null && depthHeader !== '0' && depthHeader !== 'infinity') {
		return createTextResponse('badRequest');
	}
	if (rawDepthHeader !== null && depthHeader === null) {
		return createTextResponse('badRequest');
	}

	let { timeout, expiresAt } = parseTimeout(request.headers.get('Timeout'));
	let body = await readXmlBodyWithLimit(request);
	if (body === null) {
		return createTextResponse('payloadTooLarge');
	}
	let isRefreshRequest = body === '';
	let parsedLockRequest = isRefreshRequest ? null : parseLockRequest(body);
	if (!isRefreshRequest && parsedLockRequest === null) {
		return createTextResponse('badRequest');
	}
	let requestedScope: LockDetails['scope'] = parsedLockRequest?.scope ?? 'exclusive';
	let owner = parsedLockRequest?.owner;
	let lockResponse = await assertLockPermission(request, bucket, resourcePath, sidecarConfig, {
		ignoreSharedLocksOnTarget: body !== '' && requestedScope === 'shared',
	});
	if (lockResponse !== null) {
		return lockResponse;
	}

	let refreshTarget = isRefreshRequest ? await findMatchingLock(request, bucket, resourcePath, sidecarConfig) : null;
	let lockState = await readLockState(bucket, resourcePath, sidecarConfig);
	let resource = lockState.resource;
	let existingLock = refreshTarget?.lockDetails;
	let sidecarKey = lockState.sidecarKey;
	let sidecarExists = lockState.sidecarExists;
	let sidecarLocks = lockState.sidecarLocks;
	let objectLocks = lockState.objectLocks;
	let currentLocks = lockState.locks;
	let requestLockTokens = getRequestLockTokensForTarget(request, resource, resourcePath, resource);
	if (refreshTarget !== null) {
		resource = refreshTarget.resource;
		if (refreshTarget.sidecarKey !== null) {
			sidecarKey = refreshTarget.sidecarKey;
			objectLocks = [];
			let refreshSidecarState = await readDirectorySidecarState(bucket, refreshTarget.sidecarKey);
			sidecarExists = refreshSidecarState.exists;
			sidecarLocks = refreshSidecarState.sidecar?.locks ?? [];
			currentLocks = sidecarLocks;
		}
		requestLockTokens = getRequestLockTokensForTarget(request, resource, resourcePath, resource);
	}
	let isFileResource = resource !== null && !isCollectionObject(resource);
	let isCollectionRequest = hasTrailingSlashPath(request) || (resource === null && sidecarExists);
	let isDirectoryTarget =
		!isFileResource &&
		((resource !== null && isCollectionObject(resource)) ||
			(resource === null &&
				isCollectionRequest &&
				(sidecarExists || (await hasCollectionResourceOrImplicit(bucket, resourcePath, sidecarConfig)))));
	if (
		refreshTarget === null &&
		isRefreshRequest &&
		resource !== null &&
		currentLocks.length > 0 &&
		!currentLocks.some((currentLock) => requestLockTokens.tokens.includes(currentLock.token))
	) {
		return createTextResponse('locked');
	}
	if (isRefreshRequest && refreshTarget === null) {
		return createTextResponse('badRequest');
	}

	if (resource === null) {
		if (isRefreshRequest) {
			if (refreshTarget === null && !sidecarExists) {
				return createTextResponse('badRequest');
			}
		} else {
			let parentPath = getParentPath(resourcePath);
			let parentExists = await hasCollectionResourceOrImplicit(bucket, parentPath, sidecarConfig);
			if (!parentExists) {
				return createTextResponse('conflict');
			}

			if (!sidecarExists && !hasTrailingSlashPath(request)) {
				await bucket.put(resourcePath, new Uint8Array(), {
					customMetadata: {},
				});
				resource = await bucket.head(resourcePath);
				currentLocks = [];
				isDirectoryTarget = false;
			}
		}
	}

	if (resource === null && !isDirectoryTarget) {
		return createTextResponse('notFound');
	}
	if (existingLock === undefined && hasLockScopeConflict(currentLocks, requestedScope)) {
		return createTextResponse('locked');
	}

	let baseSidecar: DirectorySidecar | null = null;
	if (isDirectoryTarget && !sidecarExists) {
		let legacy = resource ? readLegacyDirectoryMarker(resource.customMetadata) : undefined;
		baseSidecar = legacy ? legacyMarkerToSidecar(legacy) : { kind: 'directory' };
		sidecarKey = getDirectorySidecarKey(resourcePath, sidecarConfig);
		sidecarLocks = baseSidecar.locks ?? [];
		sidecarExists = true;
		currentLocks = sidecarLocks;
	}

	let depth: LockDetails['depth'];
	if (existingLock !== undefined && depthHeader === null && isRefreshRequest) {
		depth = existingLock.depth;
	} else {
		let resourceType = resource?.customMetadata?.resourcetype ?? (isDirectoryTarget ? '<collection />' : undefined);
		depth = determineLockDepth(resourceType, depthHeader);
	}

	if (existingLock === undefined && depth === 'infinity') {
		// RFC 4918 §9.10.3：深度无限的新锁覆盖全部成员；任一后代已有锁时必须整体失败，
		// 不能只检查目标资源自身的 currentLocks。
		let descendantLockResponse = await assertNoDescendantLockConflicts(
			bucket,
			resourcePath,
			sidecarConfig,
			requestedScope,
		);
		if (descendantLockResponse !== null) {
			return descendantLockResponse;
		}
	}

	let lockDetails: LockDetails = {
		token: existingLock?.token ?? crypto.randomUUID(),
		owner: owner ?? existingLock?.owner,
		scope: existingLock?.scope ?? requestedScope,
		depth,
		timeout,
		expiresAt,
		root:
			existingLock?.root ??
			getResourceHref(resource?.key ?? resourcePath, resource ? isCollectionObject(resource) : true),
	};
	let updatedObjectLocks = objectLocks;
	let updatedSidecarLocks = sidecarLocks;
	let updatedLocks = currentLocks;
	if (isDirectoryTarget) {
		updatedSidecarLocks = upsertLockDetails(sidecarLocks, lockDetails, existingLock);
		updatedLocks = updatedSidecarLocks;
	} else {
		updatedObjectLocks = upsertLockDetails(objectLocks, lockDetails, existingLock);
		updatedLocks = updatedObjectLocks;
	}

	let writtenLocks = updatedLocks;
	if (isDirectoryTarget) {
		if (sidecarKey === null) {
			return createTextResponse('notFound');
		}
		let writeResponse = await updateDirectorySidecar(bucket, sidecarKey, (currentSidecar, currentExists) => {
			// 优先使用重读状态做冲突检测；仅当 sidecar 确实不存在时才回退到 baseSidecar
			// （隐式/legacy 集合的首次 sidecar 化）。否则并发首次 LOCK 会因 baseSidecar
			// 短路而绕过 etag 重试的重读，后写覆盖先写、破坏排他锁完整性。
			let base = currentExists ? (currentSidecar ?? { kind: 'directory' as const }) : (baseSidecar ?? undefined);
			if (base === undefined) {
				return createTextResponse('notFound');
			}
			let locks = base.locks ?? [];
			if (existingLock === undefined && hasLockScopeConflict(locks, requestedScope)) {
				return createTextResponse('locked');
			}
			let nextLocks = upsertLockDetails(locks, lockDetails, existingLock);
			writtenLocks = nextLocks;
			return {
				...base,
				locks: nextLocks.length > 0 ? nextLocks : undefined,
			};
		});
		if (writeResponse !== null) {
			return writeResponse;
		}

		if (resource !== null && isCollectionObject(resource)) {
			// sidecar 已写入且为目录元数据真源；legacy marker 清理若因并发改写失败，
			// 仅残留冗余 marker（sidecar 优先），不应让客户端看到误导性的 404。
			await rewriteStoredObject(
				bucket,
				resource.key,
				stripDirectoryMetadata(resource.customMetadata),
				resource.httpMetadata,
			);
		}
	} else {
		if (resource === null) {
			return createTextResponse('notFound');
		}
		let updated = await rewriteStoredObject(
			bucket,
			resource.key,
			withLockMetadata(getPreservedCustomMetadata(resource.customMetadata), updatedObjectLocks),
		);
		if (!updated) {
			return createTextResponse('notFound');
		}
	}

	return xmlResponse(
		`<?xml version="1.0" encoding="utf-8"?>\n<prop xmlns="DAV:"><lockdiscovery>${getLockDiscovery(writtenLocks)}</lockdiscovery></prop>`,
		existingLock ? 200 : 201,
		{
			'Lock-Token': `<urn:uuid:${lockDetails.token}>`,
			...(existingLock
				? {}
				: {
						Location: getResourceHref(resource?.key ?? resourcePath, resource ? isCollectionObject(resource) : true),
					}),
		},
	);
}

export async function handleUnlock(
	request: Request,
	bucket: R2Bucket,
	sidecarConfig: SidecarConfig = DEFAULT_SIDECAR_CONFIG,
	mutationGuard?: DurableObjectNamespace,
): Promise<Response> {
	let resourcePath = makeResourcePath(request);
	let guard = await acquireResourceMutationGuard(bucket, resourcePath, sidecarConfig, mutationGuard);
	if (guard === 'capacity') {
		return createTextResponse('unavailable');
	}
	if (guard === null) {
		return createTextResponse('locked');
	}
	if (guard.isLost()) {
		await guard.release();
		return createTextResponse('unavailable');
	}
	let guardedBucket = createGuardAwareBucket(bucket, guard);
	try {
		return await unlockResource(request, guardedBucket, sidecarConfig);
	} catch (error) {
		if (error instanceof LockMutationGuardLostError) {
			return createTextResponse('unavailable');
		}
		throw error;
	} finally {
		await guard.release();
	}
}

async function unlockResource(request: Request, bucket: R2Bucket, sidecarConfig: SidecarConfig): Promise<Response> {
	let resourcePath = makeResourcePath(request);
	let lockState = await readLockState(bucket, resourcePath, sidecarConfig);
	let resource = lockState.resource;
	let sidecarExists = lockState.sidecarExists;
	let isDirectoryTarget =
		sidecarExists ||
		isCollectionObject(resource) ||
		(resource === null && (await hasCollectionResourceOrImplicit(bucket, resourcePath, sidecarConfig)));
	if (resource === null && !isDirectoryTarget) {
		return createTextResponse('notFound');
	}

	let lockToken = request.headers.get('Lock-Token');
	if (lockToken === null) {
		return createTextResponse('badRequest');
	}

	let lockResponse = await assertLockPermission(request, bucket, resourcePath, sidecarConfig);
	if (lockResponse !== null) {
		return lockResponse;
	}

	let normalizedToken = normalizeLockToken(lockToken);
	// 锁由 token 标识（RFC 4918 §9.11），可能在祖先（infinity）而非 request path；按 token 定位实际存储位置移除。
	let matching = await findMatchingLock(request, bucket, resourcePath, sidecarConfig);
	if (matching === null) {
		return createTextResponse('conflict');
	}

	if (matching.sidecarKey !== null) {
		let writeResponse = await updateDirectorySidecar(bucket, matching.sidecarKey, (currentSidecar, currentExists) => {
			let base = currentExists ? (currentSidecar ?? { kind: 'directory' as const }) : undefined;
			if (base === undefined) {
				return createTextResponse('notFound');
			}
			let locks = base.locks ?? [];
			if (!locks.some((lock) => lock.token === normalizedToken)) {
				return createTextResponse('conflict');
			}
			let remaining = locks.filter((lock) => lock.token !== normalizedToken);
			return { ...base, locks: remaining.length > 0 ? remaining : undefined };
		});
		if (writeResponse !== null) {
			return writeResponse;
		}

		if (matching.resource !== null && isCollectionObject(matching.resource)) {
			// 与 handleLock 同理：sidecar 锁已移除且 sidecar 为真源，
			// legacy marker 清理失败仅残留冗余 marker，不应误报 404。
			await rewriteStoredObject(
				bucket,
				matching.resource.key,
				stripDirectoryMetadata(matching.resource.customMetadata),
				matching.resource.httpMetadata,
			);
		}
	} else {
		if (matching.resource === null) {
			return createTextResponse('notFound');
		}
		let preservedMetadata = getPreservedCustomMetadata(matching.resource.customMetadata);
		let updatedLocks = getLockDetails(preservedMetadata).filter((lock) => lock.token !== normalizedToken);
		let updated = await rewriteStoredObject(
			bucket,
			matching.resource.key,
			withLockMetadata(preservedMetadata, updatedLocks),
			matching.resource.httpMetadata,
		);
		if (!updated) {
			return createTextResponse('notFound');
		}
	}

	return new Response(null, { status: 204 });
}
