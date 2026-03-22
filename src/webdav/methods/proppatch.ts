import { assertLockPermission, getPreservedCustomMetadata } from '../../domain/locks';
import { makeResourcePath } from '../../domain/path';
import { rewriteStoredObject } from '../../domain/storage';
import type { DeadProperty } from '../../shared/types';
import { getDeadPropertyKey, parseProppatchRequest } from '../xml';
import { createTextResponse, xmlResponse } from '../responses';
import { appendPropstatProperties, isProtectedProperty, renderProppatchResponse } from './property-shared';

export async function handleProppatch(request: Request, bucket: R2Bucket): Promise<Response> {
	let resourcePath = makeResourcePath(request);
	let lockResponse = await assertLockPermission(request, bucket, resourcePath);
	if (lockResponse !== null) {
		return lockResponse;
	}

	let object = await bucket.head(resourcePath);
	if (object === null) {
		return createTextResponse('notFound');
	}

	let parsedRequest = parseProppatchRequest(await request.text());
	if (parsedRequest === null) {
		return createTextResponse('badRequest');
	}

	let customMetadata = getPreservedCustomMetadata(object.customMetadata);
	let successfulSetProperties: DeadProperty[] = [];
	let failedSetProperties: DeadProperty[] = [];
	let successfulRemoveProperties: DeadProperty[] = [];
	let failedRemoveProperties: DeadProperty[] = [];

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
			customMetadata[propertyKey] = JSON.stringify(operation.property);
			successfulSetProperties.push(operation.property);
		} else {
			delete customMetadata[propertyKey];
			successfulRemoveProperties.push(operation.property);
		}
	}

	let hasFailures = failedSetProperties.length > 0 || failedRemoveProperties.length > 0;
	if (!hasFailures) {
		let updated = await rewriteStoredObject(bucket, object.key, customMetadata, object.httpMetadata);
		if (!updated) {
			return createTextResponse('notFound');
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

	return xmlResponse(renderProppatchResponse(object, propstats));
}
