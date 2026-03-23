import { getParentPath } from '../../domain/path';
import { hasCollectionResourceOrImplicit } from '../../domain/storage';

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

export function noContentResponse(): Response {
	return new Response(null, { status: 204 });
}

export function createTextResponse(templateName: ResponseTemplateName): Response {
	return new Response(RESPONSE_TEMPLATES[templateName].body, {
		status: RESPONSE_TEMPLATES[templateName].status,
	});
}

export async function ensureParentCollectionResource(bucket: R2Bucket, resourcePath: string): Promise<Response | null> {
	let parentPath = getParentPath(resourcePath);
	if (parentPath === '' || (await hasCollectionResourceOrImplicit(bucket, parentPath))) {
		return null;
	}

	return createTextResponse('conflict');
}
