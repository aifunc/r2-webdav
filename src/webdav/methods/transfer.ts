import { assertLockPermission, getPreservedCustomMetadata, stripLockMetadata } from '../../domain/locks';
import { stripDirectoryLocks } from '../../domain/directories';
import { makeResourcePath } from '../../domain/path';
import { resolveResource } from '../../domain/storage';
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

	let resource = await loadTransferResource(bucket, resourcePath, destination);
	if (resource instanceof Response) {
		return resource;
	}

	let parentResponse = await ensureDestinationParentExists(bucket, destination);
	if (parentResponse !== null) {
		return parentResponse;
	}

	let destinationExists = resource.isCollection
		? (await resolveResource(bucket, destination)) !== null
		: (await bucket.head(destination)) !== null;
	if (overwriteDisabled && destinationExists) {
		return createTextResponse('preconditionFailed');
	}

	if (resource.isCollection) {
		return resolveDepthTransfer(request.headers.get('Depth') ?? 'infinity', {
			infinity: async () => {
				let transferResponse = await transferCollectionOrNotFound(
					bucket,
					resource.resourcePath,
					destination,
					(object) => stripLockMetadata(object.customMetadata),
					{ mapSidecar: stripDirectoryLocks },
				);
				return completeTransfer(transferResponse, destinationExists, destination, true);
			},
			'0': async () => {
				if (resource.object === null && !destinationExists) {
					return createTextResponse('notFound');
				}
				let copyResponse = await transferCollectionOrNotFound(
					bucket,
					resource.resourcePath,
					destination,
					(object) => stripLockMetadata(object.customMetadata),
					{ includeDescendants: false, mapSidecar: stripDirectoryLocks },
				);
				return completeTransfer(copyResponse, destinationExists, destination, true);
			},
		});
	}

	if (resource.object === null) {
		return createTextResponse('notFound');
	}

	let copyResponse = await transferOrNotFound(
		bucket,
		resource.object,
		destination,
		stripLockMetadata(resource.object.customMetadata),
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

	let resource = await loadTransferResource(bucket, resourcePath, destination, moveDestinationValidation);
	if (resource instanceof Response) {
		return resource;
	}

	let parentResponse = await ensureDestinationParentExists(bucket, destination);
	if (parentResponse !== null) {
		return parentResponse;
	}

	let destinationExists = resource.isCollection
		? (await resolveResource(bucket, destination)) !== null
		: (await bucket.head(destination)) !== null;
	if (!overwrite && destinationExists) {
		return createTextResponse('preconditionFailed');
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

	if (resource.isCollection) {
		return resolveDepthTransfer(request.headers.get('Depth') ?? 'infinity', {
			infinity: async () => {
				let transferResponse = await transferCollectionOrNotFound(
					bucket,
					resource.resourcePath,
					destination,
					(object) => getPreservedCustomMetadata(object.customMetadata),
					{ deleteSource: true },
				);
				return completeTransfer(transferResponse, destinationExists, destination, true);
			},
		});
	}

	if (resource.object === null) {
		return createTextResponse('notFound');
	}

	let moveResponse = await transferOrNotFound(
		bucket,
		resource.object,
		destination,
		getPreservedCustomMetadata(resource.object.customMetadata),
		{ deleteSource: true },
	);
	if (moveResponse !== null) {
		return moveResponse;
	}

	return transferCompletedResponse(destinationExists, destination, false);
}
