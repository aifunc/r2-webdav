import { getParentPath } from '../../domain/path';
import { hasCollectionResourceOrImplicit } from '../../domain/storage';
import { DEFAULT_SIDECAR_CONFIG } from '../../shared/sidecar';
import type { SidecarConfig } from '../../shared/types';

import { createTextResponse } from '../responses';
export { createTextResponse };

export function noContentResponse(headers: HeadersInit = {}): Response {
	return new Response(null, { status: 204, headers });
}

export function buildResourceVersionHeaders(
	resource: Pick<R2Object, 'etag' | 'httpEtag' | 'uploaded'> | Pick<R2ObjectBody, 'etag' | 'httpEtag' | 'uploaded'>,
): Headers {
	let headers = new Headers();
	headers.set('ETag', resource.httpEtag || `"${resource.etag}"`);
	headers.set('Last-Modified', resource.uploaded.toUTCString());
	return headers;
}

export function assertUnmodifiedSince(request: Request, resource: { uploaded: Date } | null): Response | null {
	let unmodifiedSince = request.headers.get('If-Unmodified-Since');
	if (unmodifiedSince === null || resource === null) {
		return null;
	}

	let threshold = Date.parse(unmodifiedSince);
	if (!Number.isFinite(threshold)) {
		return null;
	}

	return resource.uploaded.getTime() > threshold + 999 ? createTextResponse('preconditionFailed') : null;
}

export function assertIfMatch(request: Request, resource: { etag: string; httpEtag?: string } | null): Response | null {
	let ifMatch = request.headers.get('If-Match');
	if (ifMatch === null) {
		return null;
	}
	if (resource === null) {
		return createTextResponse('preconditionFailed');
	}
	let etag = resource.httpEtag || `"${resource.etag}"`;
	let tags = ifMatch.split(',').map((tag) => tag.trim());
	if (tags.includes('*') || tags.includes(etag)) {
		return null;
	}
	return createTextResponse('preconditionFailed');
}

export async function ensureParentCollectionResource(
	bucket: R2Bucket,
	resourcePath: string,
	sidecarConfig: SidecarConfig = DEFAULT_SIDECAR_CONFIG,
): Promise<Response | null> {
	let parentPath = getParentPath(resourcePath);
	if (parentPath === '' || (await hasCollectionResourceOrImplicit(bucket, parentPath, sidecarConfig))) {
		return null;
	}

	return createTextResponse('conflict');
}
