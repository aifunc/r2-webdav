import { VALID_LOCK_DEPTHS } from '../../shared/constants';
import {
	assertLockPermission,
	determineLockDepth,
	extractLockOwner,
	findMatchingLock,
	getLockDetails,
	getLockDiscovery,
	hasLockScopeConflict,
	normalizeLockToken,
	parseTimeout,
	getPreservedCustomMetadata,
	getRequestLockTokens,
	upsertLockDetails,
	withLockMetadata,
} from '../../domain/locks';
import { getParentPath, getResourceHref, isCollectionObject, makeResourcePath } from '../../domain/path';
import { hasCollectionResource, rewriteStoredObject } from '../../domain/storage';
import type { LockDetails } from '../../shared/types';
import { createTextResponse, xmlResponse } from '../responses';

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
	let resource = refreshTarget?.resource ?? (await bucket.head(resourcePath));
	let currentLocks = getLockDetails(resource?.customMetadata);
	let existingLock = refreshTarget?.lockDetails;
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
			return createTextResponse('badRequest');
		}
		if (!(await hasCollectionResource(bucket, getParentPath(resourcePath))) || request.url.endsWith('/')) {
			return createTextResponse('conflict');
		}

		await bucket.put(resourcePath, new Uint8Array(), {
			customMetadata: {},
		});
		resource = await bucket.head(resourcePath);
		currentLocks = [];
	}

	if (resource === null) {
		return createTextResponse('notFound');
	}
	if (existingLock === undefined && hasLockScopeConflict(currentLocks, requestedScope)) {
		return createTextResponse('locked');
	}

	let depth: LockDetails['depth'];
	if (existingLock !== undefined && depthHeader === null && isRefreshRequest) {
		depth = existingLock.depth;
	} else {
		depth = determineLockDepth(resource.customMetadata?.resourcetype, depthHeader as LockDetails['depth'] | null);
	}

	let lockDetails: LockDetails = {
		token: existingLock?.token ?? crypto.randomUUID(),
		owner: owner ?? existingLock?.owner,
		scope: existingLock?.scope ?? requestedScope,
		depth,
		timeout,
		expiresAt,
		root: getResourceHref(resource.key, isCollectionObject(resource)),
	};
	let updatedLocks = upsertLockDetails(currentLocks, lockDetails, existingLock);

	let updated = await rewriteStoredObject(
		bucket,
		resource.key,
		withLockMetadata(getPreservedCustomMetadata(resource.customMetadata), updatedLocks),
	);
	if (!updated) {
		return createTextResponse('notFound');
	}

	return xmlResponse(
		`<?xml version="1.0" encoding="utf-8"?>\n<prop xmlns="DAV:"><lockdiscovery>${getLockDiscovery(updatedLocks)}</lockdiscovery></prop>`,
		existingLock ? 200 : 201,
		{
			'Lock-Token': `<urn:uuid:${lockDetails.token}>`,
			...(existingLock
				? {}
				: {
						Location: getResourceHref(resource.key, isCollectionObject(resource)),
					}),
		},
	);
}

export async function handleUnlock(request: Request, bucket: R2Bucket): Promise<Response> {
	let resourcePath = makeResourcePath(request);
	let resource = await bucket.head(resourcePath);
	if (resource === null) {
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

	let lockDetails = getLockDetails(resource.customMetadata);
	let normalizedToken = normalizeLockToken(lockToken);
	if (!lockDetails.some((lockDetail) => lockDetail.token === normalizedToken)) {
		return createTextResponse('conflict');
	}

	let updated = await rewriteStoredObject(
		bucket,
		resource.key,
		withLockMetadata(
			getPreservedCustomMetadata(resource.customMetadata),
			lockDetails.filter((lockDetail) => lockDetail.token !== normalizedToken),
		),
	);
	if (!updated) {
		return createTextResponse('notFound');
	}

	return new Response(null, { status: 204 });
}
