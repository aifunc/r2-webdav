import { assertLockPermission, getPreservedCustomMetadata, stripLockMetadata } from '../../domain/locks';
import { isCollectionObject, makeResourcePath } from '../../domain/path';
import { handleDelete } from '../http/handlers';
import {
	buildForwardedDeleteHeaders,
	completeTransfer,
	createTextResponse,
	ensureDestinationParentExists,
	loadTransferResource,
	moveDestinationValidation,
	resolveDepthTransfer,
	resolveDestinationTarget,
	transferCollectionOrNotFound,
	transferCompletedResponse,
	transferOrNotFound,
} from '../responses';

export async function handleCopy(request: Request, bucket: R2Bucket): Promise<Response> {
	let resourcePath = makeResourcePath(request);
	let overwriteDisabled = request.headers.get('Overwrite') === 'F';
	let destinationTarget = resolveDestinationTarget(request, resourcePath);
	if (destinationTarget instanceof Response) {
		return destinationTarget;
	}
	let destination = destinationTarget.path;

	let lockResponse = await assertLockPermission(request, bucket, destination);
	if (lockResponse !== null) {
		return lockResponse;
	}

	let parentResponse = await ensureDestinationParentExists(bucket, destination);
	if (parentResponse !== null) {
		return parentResponse;
	}

	let destinationExists = await bucket.head(destination);
	if (overwriteDisabled && destinationExists) {
		return createTextResponse('preconditionFailed');
	}

	let resource = await loadTransferResource(bucket, resourcePath, destination);
	if (resource instanceof Response) {
		return resource;
	}

	if (isCollectionObject(resource)) {
		return resolveDepthTransfer(request.headers.get('Depth') ?? 'infinity', {
			infinity: async () => {
				let transferResponse = await transferCollectionOrNotFound(bucket, resource, destination, (object) =>
					stripLockMetadata(object.customMetadata),
				);
				return completeTransfer(transferResponse, destinationExists, destination, true);
			},
			'0': async () => {
				let copyResponse = await transferOrNotFound(
					bucket,
					resource,
					destination,
					stripLockMetadata(resource.customMetadata),
				);
				return completeTransfer(copyResponse, destinationExists, destination, true);
			},
		});
	}

	let copyResponse = await transferOrNotFound(
		bucket,
		resource,
		destination,
		stripLockMetadata(resource.customMetadata),
	);
	if (copyResponse !== null) {
		return copyResponse;
	}

	return transferCompletedResponse(destinationExists, destination, false);
}

export async function handleMove(request: Request, bucket: R2Bucket): Promise<Response> {
	let resourcePath = makeResourcePath(request);
	let overwrite = (request.headers.get('Overwrite') ?? 'T') !== 'F';
	let destinationTarget = resolveDestinationTarget(request, resourcePath);
	if (destinationTarget instanceof Response) {
		return destinationTarget;
	}
	let destination = destinationTarget.path;

	let sourceLockResponse = await assertLockPermission(request, bucket, resourcePath);
	if (sourceLockResponse !== null) {
		return sourceLockResponse;
	}
	let destinationLockResponse = await assertLockPermission(request, bucket, destination);
	if (destinationLockResponse !== null) {
		return destinationLockResponse;
	}

	let parentResponse = await ensureDestinationParentExists(bucket, destination);
	if (parentResponse !== null) {
		return parentResponse;
	}

	let destinationExists = await bucket.head(destination);
	if (!overwrite && destinationExists) {
		return createTextResponse('preconditionFailed');
	}

	let resource = await loadTransferResource(bucket, resourcePath, destination, moveDestinationValidation);
	if (resource instanceof Response) {
		return resource;
	}

	if (destinationExists) {
		let deleteResponse = await handleDelete(
			new Request(new URL(destinationTarget.header), {
				method: 'DELETE',
				headers: buildForwardedDeleteHeaders(request),
			}),
			bucket,
		);
		if (!deleteResponse.ok) {
			return deleteResponse;
		}
	}

	if (isCollectionObject(resource)) {
		return resolveDepthTransfer(request.headers.get('Depth') ?? 'infinity', {
			infinity: async () => {
				let transferResponse = await transferCollectionOrNotFound(
					bucket,
					resource,
					destination,
					(object) => getPreservedCustomMetadata(object.customMetadata),
					{ deleteSource: true },
				);
				return completeTransfer(transferResponse, destinationExists, destination, true);
			},
		});
	}

	let moveResponse = await transferOrNotFound(
		bucket,
		resource,
		destination,
		getPreservedCustomMetadata(resource.customMetadata),
		{ deleteSource: true },
	);
	if (moveResponse !== null) {
		return moveResponse;
	}

	return transferCompletedResponse(destinationExists, destination, false);
}
