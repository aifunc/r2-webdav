import { assertLockPermission, getPreservedCustomMetadata, stripLockMetadata } from '../../domain/locks';
import {
	getDirectorySidecarKey,
	legacyMarkerToSidecar,
	parseDirectorySidecar,
	readLegacyDirectoryMarker,
	serializeDirectorySidecar,
} from '../../domain/directories';
import { isCollectionObject, makeResourcePath } from '../../domain/path';
import { hasCollectionResourceOrImplicit, rewriteStoredObject } from '../../domain/storage';
import { DEAD_PROPERTY_PREFIX } from '../../shared/constants';
import { DEFAULT_SIDECAR_CONFIG } from '../../shared/sidecar';
import type { DeadProperty, DirectorySidecar, SidecarConfig } from '../../shared/types';
import { getDeadPropertyKey, parseProppatchRequest } from '../xml';
import { createTextResponse, xmlResponse } from '../responses';
import { appendPropstatProperties, isProtectedProperty, renderProppatchResponse } from './property-shared';
import { assertUnmodifiedSince, buildResourceVersionHeaders } from '../http/shared';

async function readDirectorySidecar(
	bucket: R2Bucket,
	resourcePath: string,
	sidecarConfig: SidecarConfig,
): Promise<{ exists: boolean; sidecar: DirectorySidecar | undefined }> {
	let sidecarObject = await bucket.get(getDirectorySidecarKey(resourcePath, sidecarConfig));
	if (sidecarObject === null) {
		return { exists: false, sidecar: undefined };
	}
	let payload = await new Response(sidecarObject.body).text();
	return { exists: true, sidecar: parseDirectorySidecar(payload) };
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

export async function handleProppatch(
	request: Request,
	bucket: R2Bucket,
	sidecarConfig: SidecarConfig = DEFAULT_SIDECAR_CONFIG,
): Promise<Response> {
	let resourcePath = makeResourcePath(request);
	let lockResponse = await assertLockPermission(request, bucket, resourcePath, sidecarConfig);
	if (lockResponse !== null) {
		return lockResponse;
	}

	let [object, sidecarResult] = await Promise.all([
		bucket.head(resourcePath),
		readDirectorySidecar(bucket, resourcePath, sidecarConfig),
	]);
	let preconditionResponse = assertUnmodifiedSince(request, object);
	if (preconditionResponse !== null) {
		return preconditionResponse;
	}

	let parsedRequest = parseProppatchRequest(await request.text());
	if (parsedRequest === null) {
		return createTextResponse('badRequest');
	}

	let isFileResource = object !== null && !isCollectionObject(object);
	let isCollectionRequest = request.url.endsWith('/') || (object === null && sidecarResult.exists);
	let isDirectory =
		!isFileResource &&
		((object !== null && isCollectionObject(object)) ||
			(object === null &&
				isCollectionRequest &&
				(sidecarResult.exists || (await hasCollectionResourceOrImplicit(bucket, resourcePath, sidecarConfig)))));
	if (!isDirectory && object === null) {
		return createTextResponse('notFound');
	}

	let customMetadata = object ? getPreservedCustomMetadata(object.customMetadata) : {};
	let successfulSetProperties: DeadProperty[] = [];
	let failedSetProperties: DeadProperty[] = [];
	let successfulRemoveProperties: DeadProperty[] = [];
	let failedRemoveProperties: DeadProperty[] = [];

	let baseProps: DirectorySidecar['props'] = undefined;
	let baseLocks: DirectorySidecar['locks'] = undefined;
	if (isDirectory) {
		if (sidecarResult.exists) {
			baseProps = sidecarResult.sidecar?.props;
			baseLocks = sidecarResult.sidecar?.locks;
		} else if (object !== null) {
			let legacy = readLegacyDirectoryMarker(object.customMetadata);
			if (legacy !== undefined) {
				let migrated = legacyMarkerToSidecar(legacy);
				baseProps = migrated.props;
				baseLocks = migrated.locks;
			}
		}
	}

	let updatedProps: DirectorySidecar['props'] = baseProps !== undefined ? { ...baseProps } : {};

	for (const operation of parsedRequest.operations) {
		if (isProtectedProperty(operation.property)) {
			if (operation.action === 'set') {
				failedSetProperties.push(operation.property);
			} else {
				failedRemoveProperties.push(operation.property);
			}
			continue;
		}

		let propertyKey = getDeadPropertyKey(operation.property.namespaceURI, operation.property.localName);
		if (operation.action === 'set') {
			if (isDirectory) {
				updatedProps[propertyKey] = operation.property;
			} else {
				customMetadata[propertyKey] = JSON.stringify(operation.property);
			}
			successfulSetProperties.push(operation.property);
		} else {
			if (isDirectory) {
				delete updatedProps[propertyKey];
			} else {
				delete customMetadata[propertyKey];
			}
			successfulRemoveProperties.push(operation.property);
		}
	}

	let hasFailures = failedSetProperties.length > 0 || failedRemoveProperties.length > 0;
	let responseHeaders: HeadersInit = {};
	if (!hasFailures) {
		if (isDirectory) {
			let nextSidecar: DirectorySidecar = { kind: 'directory' };
			if (Object.keys(updatedProps).length > 0) {
				nextSidecar.props = updatedProps;
			}
			if (baseLocks !== undefined && baseLocks.length > 0) {
				nextSidecar.locks = baseLocks;
			}
			await bucket.put(getDirectorySidecarKey(resourcePath, sidecarConfig), serializeDirectorySidecar(nextSidecar));

			if (object !== null && isCollectionObject(object)) {
				let updatedMetadata = stripDirectoryMetadata(object.customMetadata);
				let updated = await rewriteStoredObject(bucket, object.key, updatedMetadata, object.httpMetadata);
				if (!updated) {
					return createTextResponse('notFound');
				}
			}
		} else {
			if (object === null) {
				return createTextResponse('notFound');
			}
			let updated = await rewriteStoredObject(bucket, object.key, customMetadata, object.httpMetadata);
			if (!updated) {
				return createTextResponse('notFound');
			}
			responseHeaders = buildResourceVersionHeaders(updated);
		}
	}

	let propstats = new Map<string, string[]>();
	let successStatus = hasFailures ? 'HTTP/1.1 424 Failed Dependency' : 'HTTP/1.1 200 OK';
	for (const [properties, status] of [
		[successfulSetProperties, successStatus],
		[successfulRemoveProperties, successStatus],
		[failedSetProperties, 'HTTP/1.1 403 Forbidden'],
		[failedRemoveProperties, 'HTTP/1.1 403 Forbidden'],
	] as [DeadProperty[], string][]) {
		appendPropstatProperties(propstats, properties, status);
	}

	let responseObject =
		object ??
		({
			key: resourcePath,
			customMetadata: { resourcetype: '<collection />' },
		} as unknown as R2Object);
	return xmlResponse(renderProppatchResponse(responseObject, propstats), 207, responseHeaders);
}
