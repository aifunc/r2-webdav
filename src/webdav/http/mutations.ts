import { assertLockPermission, assertRecursiveDeletePermission, getPreservedCustomMetadata } from '../../domain/locks';
import {
	getCollectionPrefix,
	getParentPath,
	hasTrailingSlashPath,
	isCollectionObject,
	makeResourcePath,
} from '../../domain/path';
import { getDirectorySidecarKey, serializeDirectorySidecar } from '../../domain/directories';
import { deleteDirectorySidecars, hasCollectionResourceOrImplicit, resolveResource } from '../../domain/storage';
import { DEFAULT_SIDECAR_CONFIG } from '../../shared/sidecar';
import type { SidecarConfig } from '../../shared/types';
import {
	assertUnmodifiedSince,
	buildResourceVersionHeaders,
	noContentResponse,
	createTextResponse,
	ensureParentCollectionResource,
} from './shared';

async function deleteListedObjects(bucket: R2Bucket, prefix?: string): Promise<void> {
	let cursor: string | undefined = undefined;
	do {
		let r2Objects = await bucket.list({
			...(prefix ? { prefix } : {}),
			cursor,
		});
		let keys = r2Objects.objects.map((object) => object.key);
		if (keys.length > 0) {
			await bucket.delete(keys);
		}

		cursor = r2Objects.truncated ? r2Objects.cursor : undefined;
	} while (cursor !== undefined);
}

export async function handlePut(
	request: Request,
	bucket: R2Bucket,
	sidecarConfig: SidecarConfig = DEFAULT_SIDECAR_CONFIG,
): Promise<Response> {
	if (hasTrailingSlashPath(request)) {
		return createTextResponse('methodNotAllowed');
	}

	let resourcePath = makeResourcePath(request);
	let lockResponse = await assertLockPermission(request, bucket, resourcePath, sidecarConfig);
	if (lockResponse !== null) {
		return lockResponse;
	}

	let existing = await bucket.head(resourcePath);
	let preconditionResponse = assertUnmodifiedSince(request, existing);
	if (preconditionResponse !== null) {
		return preconditionResponse;
	}
	let parentResponse = await ensureParentCollectionResource(bucket, resourcePath, sidecarConfig);
	if (parentResponse !== null) {
		return parentResponse;
	}

	let body = await request.arrayBuffer();
	let stored = await bucket.put(resourcePath, body, {
		onlyIf: request.headers,
		httpMetadata: request.headers,
		customMetadata: getPreservedCustomMetadata(existing?.customMetadata),
	});
	if (stored === null) {
		return createTextResponse('preconditionFailed');
	}

	let headers = buildResourceVersionHeaders(stored);
	return existing === null ? new Response('', { status: 201, headers }) : noContentResponse(headers);
}

export async function handleDelete(
	request: Request,
	bucket: R2Bucket,
	sidecarConfig: SidecarConfig = DEFAULT_SIDECAR_CONFIG,
): Promise<Response> {
	let resourcePath = makeResourcePath(request);
	if (resourcePath === '') {
		return createTextResponse('forbidden');
	}

	let lockResponse = await assertRecursiveDeletePermission(request, bucket, resourcePath, sidecarConfig);
	if (lockResponse !== null) {
		return lockResponse;
	}

	let resolved = await resolveResource(bucket, resourcePath, sidecarConfig);
	if (resolved === null) {
		return createTextResponse('notFound');
	}
	let preconditionResponse = assertUnmodifiedSince(request, resolved.object);
	if (preconditionResponse !== null) {
		return preconditionResponse;
	}
	if (!resolved.isCollection) {
		await bucket.delete(resourcePath);
		return noContentResponse();
	}

	await deleteListedObjects(bucket, getCollectionPrefix(resourcePath));
	await deleteDirectorySidecars(bucket, resourcePath, sidecarConfig);
	let storedResource = await bucket.head(resourcePath);
	if (isCollectionObject(storedResource)) {
		await bucket.delete(resourcePath);
	}
	return noContentResponse();
}

export async function handleMkcol(
	request: Request,
	bucket: R2Bucket,
	sidecarConfig: SidecarConfig = DEFAULT_SIDECAR_CONFIG,
): Promise<Response> {
	if ((await request.clone().arrayBuffer()).byteLength > 0) {
		return createTextResponse('unsupportedMediaType');
	}

	let resourcePath = makeResourcePath(request);
	let lockResponse = await assertLockPermission(request, bucket, resourcePath, sidecarConfig);
	if (lockResponse !== null) {
		return lockResponse;
	}

	let resolved = await resolveResource(bucket, resourcePath, sidecarConfig);
	if (resolved !== null) {
		return createTextResponse('methodNotAllowed');
	}

	let parentPath = getParentPath(resourcePath);
	if (!(await hasCollectionResourceOrImplicit(bucket, parentPath, sidecarConfig))) {
		return createTextResponse('conflict');
	}

	await bucket.put(
		getDirectorySidecarKey(resourcePath, sidecarConfig),
		serializeDirectorySidecar({ kind: 'directory' }),
	);
	return new Response('', { status: 201 });
}
