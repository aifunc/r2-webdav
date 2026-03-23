import { getResourceHref, makeResourcePath } from '../../domain/path';
import { listCollectionChildren, listCollectionDescendants, resolveResource } from '../../domain/storage';
import type { DeadProperty, PropfindRequest } from '../../shared/types';
import {
	escapeXml,
	fromR2Object,
	getDeadProperties,
	getDeadProperty,
	getLivePropertyValue,
	parsePropfindRequest,
	renderDavProperty,
	renderPropertyElement,
	renderPropstat,
} from '../xml';
import { createTextResponse, xmlResponse } from '../responses';
import { renderEmptyRequestedProperty } from './property-shared';

type PropfindProperties = {
	okProperties: string[];
	missingProperties: string[];
};

type PropfindResource = {
	key: string;
	object: R2Object | null;
	isCollection: boolean;
};

function getPropfindProperties(object: R2Object | null, propfindRequest: PropfindRequest): PropfindProperties {
	let deadProperties = getDeadProperties(object?.customMetadata);
	let liveProperties = Object.entries(fromR2Object(object)).flatMap(([key, value]) =>
		value === undefined ? [] : [renderDavProperty(key, value)],
	);

	let okProperties: string[] = [];
	let missingProperties: string[] = [];

	switch (propfindRequest.mode) {
		case 'allprop': {
			okProperties = [...liveProperties, ...deadProperties.map(renderPropertyElement)];
			break;
		}
		case 'propname': {
			okProperties = [
				...Object.entries(fromR2Object(object)).flatMap(([key, value]) =>
					value === undefined ? [] : [renderDavProperty(key, '')],
				),
				...deadProperties.map(renderEmptyRequestedProperty),
			];
			break;
		}
		case 'prop': {
			for (const property of propfindRequest.properties) {
				let liveValue = getLivePropertyValue(object, property);
				if (liveValue !== undefined) {
					okProperties.push(renderDavProperty(property.localName, liveValue));
					continue;
				}

				let deadProperty = getDeadProperty(object?.customMetadata, property.namespaceURI, property.localName);
				if (deadProperty !== null) {
					okProperties.push(renderPropertyElement(deadProperty));
				} else {
					missingProperties.push(renderEmptyRequestedProperty(property));
				}
			}
			break;
		}
	}

	return { okProperties, missingProperties };
}

function generatePropfindResponse(resource: PropfindResource, propfindRequest: PropfindRequest): string {
	let href = getResourceHref(resource.key, resource.isCollection);
	let { okProperties, missingProperties } = getPropfindProperties(resource.object, propfindRequest);
	return `
	<response>
		<href>${escapeXml(href)}</href>${renderPropstat('HTTP/1.1 200 OK', okProperties)}${renderPropstat('HTTP/1.1 404 Not Found', missingProperties)}
	</response>`;
}

function buildMultiStatusXml(responses: string[]): string {
	return `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">${responses.join('')}
</multistatus>
`;
}

async function listPropfindResponses(
	bucket: R2Bucket,
	resourcePath: string,
	propfindRequest: PropfindRequest,
	isRecursive: boolean,
): Promise<string[]> {
	let responses: string[] = [];
	let iterator = isRecursive
		? listCollectionDescendants(bucket, resourcePath)
		: listCollectionChildren(bucket, resourcePath);
	for await (let entry of iterator) {
		responses.push(generatePropfindResponse(entry, propfindRequest));
	}

	return responses;
}

async function resolvePropfindDepthResponses(
	bucket: R2Bucket,
	resourcePath: string,
	propfindRequest: PropfindRequest,
	depth: string,
): Promise<string[] | null> {
	let depthHandlers: Record<string, () => Promise<string[]>> = {
		'0': async () => [],
		'1': async () => listPropfindResponses(bucket, resourcePath, propfindRequest, false),
		infinity: async () => listPropfindResponses(bucket, resourcePath, propfindRequest, true),
	};
	let depthHandler = depthHandlers[depth];
	if (depthHandler === undefined) {
		return null;
	}

	return depthHandler();
}

export async function handlePropfind(request: Request, bucket: R2Bucket): Promise<Response> {
	let resourcePath = makeResourcePath(request);
	let propfindRequest = parsePropfindRequest(await request.text());
	if (propfindRequest === null) {
		return createTextResponse('badRequest');
	}

	let resolved = await resolveResource(bucket, resourcePath);
	if (resolved === null) {
		return createTextResponse('notFound');
	}

	let responses: string[] = [];
	let isCollection = resolved.isCollection;
	responses.push(
		generatePropfindResponse(
			{
				key: resourcePath,
				object: resolved.object,
				isCollection: resolved.isCollection,
			},
			propfindRequest,
		),
	);

	if (isCollection) {
		let depth = request.headers.get('Depth') ?? 'infinity';
		let depthResponses = await resolvePropfindDepthResponses(bucket, resourcePath, propfindRequest, depth);
		if (depthResponses === null) {
			return createTextResponse('badRequest');
		}
		responses.push(...depthResponses);
	}

	return xmlResponse(buildMultiStatusXml(responses));
}
