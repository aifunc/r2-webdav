import { assertLockPermission, getPreservedCustomMetadata, stripLockMetadata } from '../../domain/locks';
import {
	getDirectorySidecarKey,
	legacyMarkerToSidecar,
	readDirectorySidecarState,
	readLegacyDirectoryMarker,
	updateDirectorySidecar,
} from '../../domain/directories';
import { hasTrailingSlashPath, isCollectionObject, makeResourcePath } from '../../domain/path';
import { hasCollectionResourceOrImplicit, rewriteStoredObject } from '../../domain/storage';
import { DEAD_PROPERTY_PREFIX } from '../../shared/constants';
import { DEFAULT_SIDECAR_CONFIG } from '../../shared/sidecar';
import type { DeadProperty, DirectorySidecar, SidecarConfig } from '../../shared/types';
import { getDeadPropertyKey, parseProppatchRequest } from '../xml';
import { createTextResponse, readXmlBodyWithLimit, xmlResponse } from '../responses';
import { appendPropstatProperties, isProtectedProperty, renderProppatchResponse } from './property-shared';
import { assertIfMatch, assertUnmodifiedSince, buildResourceVersionHeaders } from '../http/shared';

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
		readDirectorySidecarState(bucket, getDirectorySidecarKey(resourcePath, sidecarConfig)),
	]);
	let preconditionResponse = assertIfMatch(request, object);
	if (preconditionResponse !== null) {
		return preconditionResponse;
	}
	preconditionResponse = assertUnmodifiedSince(request, object);
	if (preconditionResponse !== null) {
		return preconditionResponse;
	}

	let body = await readXmlBodyWithLimit(request);
	if (body === null) {
		return createTextResponse('payloadTooLarge');
	}
	let parsedRequest = parseProppatchRequest(body);
	if (parsedRequest === null) {
		return createTextResponse('badRequest');
	}

	let isFileResource = object !== null && !isCollectionObject(object);
	let isCollectionRequest = hasTrailingSlashPath(request) || (object === null && sidecarResult.exists);
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

	for (const operation of parsedRequest.operations) {
		if (isProtectedProperty(operation.property)) {
			if (operation.action === 'set') {
				failedSetProperties.push(operation.property);
			} else {
				failedRemoveProperties.push(operation.property);
			}
			continue;
		}

		if (operation.action === 'set') {
			if (!isDirectory) {
				customMetadata[getDeadPropertyKey(operation.property.namespaceURI, operation.property.localName)] =
					JSON.stringify(operation.property);
			}
			successfulSetProperties.push(operation.property);
		} else {
			if (!isDirectory) {
				delete customMetadata[getDeadPropertyKey(operation.property.namespaceURI, operation.property.localName)];
			}
			successfulRemoveProperties.push(operation.property);
		}
	}

	let hasFailures = failedSetProperties.length > 0 || failedRemoveProperties.length > 0;
	let responseHeaders: HeadersInit = {};
	if (!hasFailures) {
		if (isDirectory) {
			let writeResponse = await updateDirectorySidecar(
				bucket,
				getDirectorySidecarKey(resourcePath, sidecarConfig),
				(currentSidecar) => {
					let nextProps: Record<string, DeadProperty> = { ...(currentSidecar?.props ?? baseProps ?? {}) };
					// RFC 4918 §9.2：PROPPATCH 的 set/remove 必须按文档顺序应用；
					// 同一属性先 set 后 remove 时，最终状态必须是 remove。
					for (const operation of parsedRequest.operations) {
						if (isProtectedProperty(operation.property)) {
							continue;
						}
						let propertyKey = getDeadPropertyKey(operation.property.namespaceURI, operation.property.localName);
						if (operation.action === 'set') {
							nextProps[propertyKey] = operation.property;
						} else {
							delete nextProps[propertyKey];
						}
					}
					let nextSidecar: DirectorySidecar = {
						kind: 'directory',
						...(currentSidecar?.uploaded !== undefined ? { uploaded: currentSidecar.uploaded } : {}),
					};
					if (Object.keys(nextProps).length > 0) {
						nextSidecar.props = nextProps;
					}
					let locks = currentSidecar?.locks ?? baseLocks;
					if (locks !== undefined && locks.length > 0) {
						nextSidecar.locks = locks;
					}
					return nextSidecar;
				},
			);
			if (writeResponse !== null) {
				return writeResponse;
			}

			if (object !== null && isCollectionObject(object)) {
				// sidecar 已写入且为目录元数据真源；legacy marker 清理若因并发改写失败，
				// 仅残留冗余 marker（sidecar 优先），不应让客户端看到误导性的 404。
				await rewriteStoredObject(
					bucket,
					object.key,
					stripDirectoryMetadata(object.customMetadata),
					object.httpMetadata,
				);
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
