import { INTERNAL_DELETE_FORWARD_HEADERS } from '../shared/constants';
import {
	getParentPath,
	getResourceHref,
	hasConflictingCollectionDestination,
	isReservedWebdavNamespace,
	isSameOrDescendantPath,
	parseDestinationPath,
} from '../domain/path';
import {
	hasCollectionResourceOrImplicit,
	resolveResource,
	transferDirectoryResources,
	transferObject,
} from '../domain/storage';
import type { DirectorySidecar, SidecarConfig } from '../shared/types';
import { DEFAULT_SIDECAR_CONFIG } from '../shared/sidecar';

export type ResponseDepthHandler = () => Promise<Response>;
export type DestinationTarget = {
	header: string;
	path: string;
};
export type TransferResource = {
	resourcePath: string;
	object: R2Object | null;
	isCollection: boolean;
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
	destinationExists: boolean,
	destination: string,
	isCollection: boolean,
): Response {
	if (destinationExists) {
		return new Response(null, { status: 204 });
	}

	return createdResponse(destination, isCollection);
}

export function resolveDepthHandler<T>(depth: string, handlers: Record<string, T>): T | null {
	return handlers[depth] ?? null;
}

export function resolveDestinationTarget(
	request: Request,
	resourcePath: string,
	sidecarConfig: SidecarConfig = DEFAULT_SIDECAR_CONFIG,
): DestinationTarget | Response {
	let destinationHeader = request.headers.get('Destination');
	if (destinationHeader === null) {
		return createTextResponse('badRequest');
	}

	let destination = parseDestinationPath(destinationHeader, request.url);
	if (
		destination === null ||
		isReservedWebdavNamespace(destination, sidecarConfig) ||
		isSameOrDescendantPath(resourcePath, destination)
	) {
		return createTextResponse('badRequest');
	}

	return {
		header: destinationHeader,
		path: destination,
	};
}

export async function ensureDestinationParentExists(
	bucket: R2Bucket,
	destination: string,
	sidecarConfig: SidecarConfig = DEFAULT_SIDECAR_CONFIG,
): Promise<Response | null> {
	let parentPath = getParentPath(destination);
	if (await hasCollectionResourceOrImplicit(bucket, parentPath, sidecarConfig)) {
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
	resourcePath: string,
	destination: string,
	mapMetadata: (object: R2Object) => Record<string, string>,
	sidecarConfig: SidecarConfig = DEFAULT_SIDECAR_CONFIG,
	options: {
		deleteSource?: boolean;
		includeDescendants?: boolean;
		mapSidecar?: (sidecar: DirectorySidecar) => DirectorySidecar;
	} = {},
): Promise<Response | null> {
	let transferred = await transferDirectoryResources(
		bucket,
		resourcePath,
		destination,
		mapMetadata,
		sidecarConfig,
		options,
	);
	return transferred ? null : createTextResponse('notFound');
}

export function completeTransfer(
	transferResponse: Response | null,
	destinationExists: boolean,
	destination: string,
	isCollection: boolean,
): Response {
	return transferResponse ?? transferCompletedResponse(destinationExists, destination, isCollection);
}

export function validateCollectionDestination(
	resourcePath: string,
	isCollection: boolean,
	destination: string,
): Response | null {
	if (isCollection && hasConflictingCollectionDestination(resourcePath, destination)) {
		return createTextResponse('badRequest');
	}

	return null;
}

export function moveDestinationValidation(
	resourcePath: string,
	isCollection: boolean,
	destination: string,
): Response | null {
	if (resourcePath === destination) {
		return createTextResponse('badRequest');
	}

	return validateCollectionDestination(resourcePath, isCollection, destination);
}

export async function loadTransferResource(
	bucket: R2Bucket,
	resourcePath: string,
	destination: string,
	sidecarConfig: SidecarConfig = DEFAULT_SIDECAR_CONFIG,
	validateDestination: (
		resourcePath: string,
		isCollection: boolean,
		destination: string,
	) => Response | null = validateCollectionDestination,
): Promise<TransferResource | Response> {
	let resource = await resolveResource(bucket, resourcePath, sidecarConfig);
	if (resource === null) {
		return createTextResponse('notFound');
	}

	let validationResponse = validateDestination(resourcePath, resource.isCollection, destination);
	return validationResponse ?? { resourcePath, object: resource.object, isCollection: resource.isCollection };
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
