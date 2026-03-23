import { getParentPath } from '../../domain/path';
import { hasCollectionResourceOrImplicit } from '../../domain/storage';
import { DEFAULT_SIDECAR_CONFIG } from '../../shared/sidecar';
import type { SidecarConfig } from '../../shared/types';

type ResponseTemplateName =
	| 'methodNotAllowed'
	| 'notFound'
	| 'conflict'
	| 'preconditionFailed'
	| 'unsupportedMediaType';

const RESPONSE_TEMPLATES: Record<ResponseTemplateName, { body: string; status: number }> = {
	methodNotAllowed: {
		body: 'Method Not Allowed',
		status: 405,
	},
	notFound: {
		body: 'Not Found',
		status: 404,
	},
	conflict: {
		body: 'Conflict',
		status: 409,
	},
	preconditionFailed: {
		body: 'Precondition Failed',
		status: 412,
	},
	unsupportedMediaType: {
		body: 'Unsupported Media Type',
		status: 415,
	},
};

export function noContentResponse(headers: HeadersInit = {}): Response {
	return new Response(null, { status: 204, headers });
}

export function createTextResponse(templateName: ResponseTemplateName): Response {
	return new Response(RESPONSE_TEMPLATES[templateName].body, {
		status: RESPONSE_TEMPLATES[templateName].status,
	});
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
