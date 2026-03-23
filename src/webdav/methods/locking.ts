import { DEAD_PROPERTY_PREFIX, VALID_LOCK_DEPTHS } from '../../shared/constants';
import {
	assertLockPermission,
	determineLockDepth,
	extractLockOwner,
	findMatchingLock,
	getLockDiscovery,
	hasLockScopeConflict,
	normalizeLockToken,
	parseTimeout,
	getPreservedCustomMetadata,
	getRequestLockTokens,
	stripLockMetadata,
	upsertLockDetails,
	withLockMetadata,
	readLockState,
} from '../../domain/locks';
import { getParentPath, getResourceHref, isCollectionObject, makeResourcePath } from '../../domain/path';
import { hasCollectionResourceOrImplicit, rewriteStoredObject } from '../../domain/storage';
import type { DirectorySidecar, LockDetails } from '../../shared/types';
import {
	getDirectorySidecarKey,
	legacyMarkerToSidecar,
	parseDirectorySidecar,
	readLegacyDirectoryMarker,
	serializeDirectorySidecar,
} from '../../domain/directories';
import { createTextResponse, xmlResponse } from '../responses';

async function readDirectorySidecarState(
	bucket: R2Bucket,
	sidecarKey: string,
): Promise<{ exists: boolean; sidecar: DirectorySidecar | null }> {
	let sidecarObject = await bucket.get(sidecarKey);
	if (sidecarObject === null) {
		return { exists: false, sidecar: null };
	}
	let payload = await new Response(sidecarObject.body).text();
	let sidecar = parseDirectorySidecar(payload);
	return { exists: true, sidecar: sidecar ?? { kind: 'directory' } };
}

function stripDirectoryMetadata(customMetadata: Record<string, string> | undefined): Record<string, string> {
	let metadata = stripLockMetadata(customMetadata);
	for (const key of Object.keys(metadata)) {
		if (key.startsWith(DEAD_PROPERTY_PREFIX)) {
			delete metadata[key];
		}
	}
	return metadata;
}

export async function handleLock(request: Request, bucket: R2Bucket): Promise<Response> {
	let resourcePath = makeResourcePath(request);
	let depthHeader = request.headers.get('Depth');
	if (depthHeader !== null && !VALID_LOCK_DEPTHS.includes(depthHeader as (typeof VALID_LOCK_DEPTHS)[number])) {
		return createTextResponse('badRequest');
	}

	let { timeout, expiresAt } = parseTimeout(request.headers.get('Timeout'));
	let body = await request.text();
	let isRefreshRequest = body === '';
	let requestedScope: LockDetails['scope'] = /<shared\b/i.test(body) ? 'shared' : 'exclusive';
	let requestLockTokens = getRequestLockTokens(request);
	if (body !== '' && !/<write\b/i.test(body)) {
		return createTextResponse('badRequest');
	}

	let owner = extractLockOwner(body);
	let lockResponse = await assertLockPermission(request, bucket, resourcePath, {
		ignoreSharedLocksOnTarget: body !== '' && requestedScope === 'shared',
	});
	if (lockResponse !== null) {
		return lockResponse;
	}

	let refreshTarget = isRefreshRequest ? await findMatchingLock(request, bucket, resourcePath) : null;
	let lockState = await readLockState(bucket, resourcePath);
	let resource = lockState.resource;
	let existingLock = refreshTarget?.lockDetails;
	let sidecarKey = lockState.sidecarKey;
	let sidecarExists = lockState.sidecarExists;
	let sidecarLocks = lockState.sidecarLocks;
	let objectLocks = lockState.objectLocks;
	let currentLocks = lockState.locks;
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
	}
	let isFileResource = resource !== null && !isCollectionObject(resource);
	let isCollectionRequest = request.url.endsWith('/') || (resource === null && sidecarExists);
	let isDirectoryTarget =
		!isFileResource &&
		((resource !== null && isCollectionObject(resource)) ||
			(resource === null &&
				isCollectionRequest &&
				(sidecarExists || (await hasCollectionResourceOrImplicit(bucket, resourcePath)))));
	if (
		refreshTarget === null &&
		isRefreshRequest &&
		resource !== null &&
		currentLocks.length > 0 &&
		!currentLocks.some((currentLock) => requestLockTokens.includes(currentLock.token))
	) {
		return createTextResponse('locked');
	}

	if (resource === null) {
		if (isRefreshRequest) {
			if (refreshTarget === null && !sidecarExists) {
				return createTextResponse('badRequest');
			}
		} else {
			let parentPath = getParentPath(resourcePath);
			let parentExists = await hasCollectionResourceOrImplicit(bucket, parentPath);
			if (!parentExists) {
				return createTextResponse('conflict');
			}

			if (!sidecarExists && !request.url.endsWith('/')) {
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
		sidecarKey = getDirectorySidecarKey(resourcePath);
		sidecarLocks = baseSidecar.locks ?? [];
		sidecarExists = true;
		currentLocks = sidecarLocks;
	}

	let depth: LockDetails['depth'];
	if (existingLock !== undefined && depthHeader === null && isRefreshRequest) {
		depth = existingLock.depth;
	} else {
		let resourceType = resource?.customMetadata?.resourcetype ?? (isDirectoryTarget ? '<collection />' : undefined);
		depth = determineLockDepth(resourceType, depthHeader as LockDetails['depth'] | null);
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

	if (isDirectoryTarget) {
		if (sidecarKey === null) {
			return createTextResponse('notFound');
		}
		let sidecarState = baseSidecar
			? { exists: true, sidecar: baseSidecar }
			: await readDirectorySidecarState(bucket, sidecarKey);
		if (!sidecarState.exists || sidecarState.sidecar === null) {
			return createTextResponse('notFound');
		}
		let sidecar = sidecarState.sidecar;
		let updatedSidecar = {
			...sidecar,
			locks: updatedSidecarLocks.length > 0 ? updatedSidecarLocks : undefined,
		};
		await bucket.put(sidecarKey, serializeDirectorySidecar(updatedSidecar));

		if (resource !== null && isCollectionObject(resource)) {
			let updatedMetadata = stripDirectoryMetadata(resource.customMetadata);
			let updated = await rewriteStoredObject(bucket, resource.key, updatedMetadata, resource.httpMetadata);
			if (!updated) {
				return createTextResponse('notFound');
			}
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
		`<?xml version="1.0" encoding="utf-8"?>\n<prop xmlns="DAV:"><lockdiscovery>${getLockDiscovery(updatedLocks)}</lockdiscovery></prop>`,
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

export async function handleUnlock(request: Request, bucket: R2Bucket): Promise<Response> {
	let resourcePath = makeResourcePath(request);
	let lockState = await readLockState(bucket, resourcePath);
	let resource = lockState.resource;
	let sidecarKey = lockState.sidecarKey;
	let sidecarExists = lockState.sidecarExists;
	let sidecarLocks = lockState.sidecarLocks;
	let isDirectoryTarget =
		sidecarExists ||
		isCollectionObject(resource) ||
		(resource === null && (await hasCollectionResourceOrImplicit(bucket, resourcePath)));
	if (resource === null && !isDirectoryTarget) {
		return createTextResponse('notFound');
	}

	let lockToken = request.headers.get('Lock-Token');
	if (lockToken === null) {
		return createTextResponse('badRequest');
	}

	let lockResponse = await assertLockPermission(request, bucket, resourcePath);
	if (lockResponse !== null) {
		return lockResponse;
	}

	let lockDetails = lockState.locks;
	let normalizedToken = normalizeLockToken(lockToken);
	if (!lockDetails.some((lockDetail) => lockDetail.token === normalizedToken)) {
		return createTextResponse('conflict');
	}

	let baseSidecar: DirectorySidecar | null = null;
	if (isDirectoryTarget && !sidecarExists) {
		let legacy = resource ? readLegacyDirectoryMarker(resource.customMetadata) : undefined;
		baseSidecar = legacy ? legacyMarkerToSidecar(legacy) : { kind: 'directory' };
		sidecarKey = getDirectorySidecarKey(resourcePath);
		sidecarLocks = baseSidecar.locks ?? [];
		sidecarExists = true;
		lockDetails = sidecarLocks;
	}

	let updatedLocks = lockDetails.filter((lockDetail) => lockDetail.token !== normalizedToken);
	if (isDirectoryTarget) {
		if (sidecarKey === null) {
			return createTextResponse('notFound');
		}
		let sidecarState = baseSidecar
			? { exists: true, sidecar: baseSidecar }
			: await readDirectorySidecarState(bucket, sidecarKey);
		if (!sidecarState.exists || sidecarState.sidecar === null) {
			return createTextResponse('notFound');
		}
		let sidecar = sidecarState.sidecar;
		let updatedSidecar = { ...sidecar, locks: updatedLocks.length > 0 ? updatedLocks : undefined };
		await bucket.put(sidecarKey, serializeDirectorySidecar(updatedSidecar));

		if (resource !== null && isCollectionObject(resource)) {
			let updatedMetadata = stripDirectoryMetadata(resource.customMetadata);
			let updated = await rewriteStoredObject(bucket, resource.key, updatedMetadata, resource.httpMetadata);
			if (!updated) {
				return createTextResponse('notFound');
			}
		}
	} else {
		let updatedObjectLocks = lockState.objectLocks.filter((lockDetail) => lockDetail.token !== normalizedToken);
		if (resource !== null && updatedObjectLocks.length !== lockState.objectLocks.length) {
			let updated = await rewriteStoredObject(
				bucket,
				resource.key,
				withLockMetadata(getPreservedCustomMetadata(resource.customMetadata), updatedObjectLocks),
			);
			if (!updated) {
				return createTextResponse('notFound');
			}
		} else if (resource === null) {
			return createTextResponse('notFound');
		}
	}

	return new Response(null, { status: 204 });
}
