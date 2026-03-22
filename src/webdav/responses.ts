import { INTERNAL_DELETE_FORWARD_HEADERS } from '../shared/constants';
import {
	getParentPath,
	getResourceHref,
	hasConflictingCollectionDestination,
	isCollectionObject,
	isSameOrDescendantPath,
	parseDestinationPath,
} from '../domain/path';
import { hasCollectionResource, transferCollectionDescendants, transferObject } from '../domain/storage';

export type ResponseDepthHandler = () => Promise<Response>;
export type DestinationTarget = {
	header: string;
	path: string;
};
type ResponseTemplateName = 'badRequest' | 'notFound' | 'conflict' | 'preconditionFailed' | 'locked';

const RESPONSE_TEMPLATES: Record<ResponseTemplateName, { body: string; status: number }> = {
	badRequest: {
		body: 'Bad Request',
		status: 400,
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
	locked: {
		body: 'Locked',
		status: 423,
	},
};

export function createTextResponse(templateName: ResponseTemplateName): Response {
	return new Response(RESPONSE_TEMPLATES[templateName].body, {
		status: RESPONSE_TEMPLATES[templateName].status,
	});
}

export function xmlResponse(body: string, status: number = 207, headers: HeadersInit = {}): Response {
	return new Response(body, {
		status,
		headers: {
			'Content-Type': 'application/xml; charset=utf-8',
			...headers,
		},
	});
}

export function createdResponse(
	resourcePath: string,
	isCollection: boolean,
	body: BodyInit | null = '',
	headers: HeadersInit = {},
): Response {
	let responseHeaders = new Headers(headers);
	responseHeaders.set('Location', getResourceHref(resourcePath, isCollection));
	return new Response(body, {
		status: 201,
		headers: responseHeaders,
	});
}

export function transferCompletedResponse(
	destinationExists: R2Object | null,
	destination: string,
	isCollection: boolean,
): Response {
	if (destinationExists !== null) {
		return new Response(null, { status: 204 });
	}

	return createdResponse(destination, isCollection);
}

export function resolveDepthHandler<T>(depth: string, handlers: Record<string, T>): T | null {
	return handlers[depth] ?? null;
}

export function resolveDestinationTarget(request: Request, resourcePath: string): DestinationTarget | Response {
	let destinationHeader = request.headers.get('Destination');
	if (destinationHeader === null) {
		return createTextResponse('badRequest');
	}

	let destination = parseDestinationPath(destinationHeader, request.url);
	if (destination === null || isSameOrDescendantPath(resourcePath, destination)) {
		return createTextResponse('badRequest');
	}

	return {
		header: destinationHeader,
		path: destination,
	};
}

export async function ensureDestinationParentExists(bucket: R2Bucket, destination: string): Promise<Response | null> {
	if (await hasCollectionResource(bucket, getParentPath(destination))) {
		return null;
	}

	return createTextResponse('conflict');
}

export async function transferOrNotFound(
	bucket: R2Bucket,
	resource: R2Object,
	destination: string,
	customMetadata: Record<string, string>,
	options: { deleteSource?: boolean } = {},
): Promise<Response | null> {
	let transferred = await transferObject(bucket, resource, destination, customMetadata, options);
	return transferred ? null : createTextResponse('notFound');
}

export async function transferCollectionOrNotFound(
	bucket: R2Bucket,
	resource: R2Object,
	destination: string,
	mapMetadata: (object: R2Object) => Record<string, string>,
	options: { deleteSource?: boolean } = {},
): Promise<Response | null> {
	let transferred = await transferCollectionDescendants(bucket, resource, destination, mapMetadata, options);
	return transferred ? null : createTextResponse('notFound');
}

export function completeTransfer(
	transferResponse: Response | null,
	destinationExists: R2Object | null,
	destination: string,
	isCollection: boolean,
): Response {
	return transferResponse ?? transferCompletedResponse(destinationExists, destination, isCollection);
}

export function validateCollectionDestination(resource: R2Object, destination: string): Response | null {
	if (isCollectionObject(resource) && hasConflictingCollectionDestination(resource.key, destination)) {
		return createTextResponse('badRequest');
	}

	return null;
}

export function moveDestinationValidation(resource: R2Object, destination: string): Response | null {
	if (resource.key === destination) {
		return createTextResponse('badRequest');
	}

	return validateCollectionDestination(resource, destination);
}

export async function loadTransferResource(
	bucket: R2Bucket,
	resourcePath: string,
	destination: string,
	validateDestination: (resource: R2Object, destination: string) => Response | null = validateCollectionDestination,
): Promise<R2Object | Response> {
	let resource = await bucket.head(resourcePath);
	if (resource === null) {
		return createTextResponse('notFound');
	}

	let validationResponse = validateDestination(resource, destination);
	return validationResponse ?? resource;
}

export function buildForwardedDeleteHeaders(request: Request): Headers {
	let headers = new Headers();
	for (const headerName of INTERNAL_DELETE_FORWARD_HEADERS) {
		let headerValue = request.headers.get(headerName);
		if (headerValue !== null) {
			headers.set(headerName, headerValue);
		}
	}

	return headers;
}

export async function resolveDepthTransfer(
	depth: string,
	handlers: Record<string, ResponseDepthHandler>,
): Promise<Response> {
	let depthHandler = resolveDepthHandler(depth, handlers);
	if (depthHandler === null) {
		return createTextResponse('badRequest');
	}

	return depthHandler();
}
