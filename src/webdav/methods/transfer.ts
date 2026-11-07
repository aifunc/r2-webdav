import {
	assertLockPermission,
	assertRecursiveDeletePermission,
	getPreservedCustomMetadata,
	rewriteLockRoots,
	stripLockMetadata,
} from '../../domain/locks';
import { stripDirectoryLocks } from '../../domain/directories';
import { isCollectionObject, getResourceHref, makeResourcePath } from '../../domain/path';
import { resolveResource } from '../../domain/storage';
import { DEFAULT_SIDECAR_CONFIG } from '../../shared/sidecar';
import type { SidecarConfig } from '../../shared/types';
import { handleDelete } from '../http/handlers';
import { assertIfMatch, assertUnmodifiedSince } from '../http/shared';
import {
	buildForwardedDeleteHeaders,
	completeTransfer,
	createTextResponse,
	ensureDestinationParentExists,
	loadTransferResource,
	moveDestinationValidation,
	normalizeDepthHeader,
	parseOverwriteHeader,
	resolveDepthTransfer,
	resolveDestinationTarget,
	transferCollectionOrNotFound,
	transferCompletedResponse,
	transferOrNotFound,
} from '../responses';

export async function handleCopy(
	request: Request,
	bucket: R2Bucket,
	sidecarConfig: SidecarConfig = DEFAULT_SIDECAR_CONFIG,
): Promise<Response> {
	let resourcePath = makeResourcePath(request);
	let overwrite = parseOverwriteHeader(request.headers.get('Overwrite'));
	if (overwrite === null) {
		return createTextResponse('badRequest');
	}
	let overwriteDisabled = !overwrite;
	let destinationTarget = resolveDestinationTarget(request, resourcePath, sidecarConfig);
	if (destinationTarget instanceof Response) {
		return destinationTarget;
	}
	let destination = destinationTarget.path;

	let lockResponse = await assertLockPermission(request, bucket, destination, sidecarConfig);
	if (lockResponse !== null) {
		return lockResponse;
	}

	let resource = await loadTransferResource(bucket, resourcePath, destination, sidecarConfig);
	if (resource instanceof Response) {
		return resource;
	}

	// 在任何破坏性操作（尤其是覆盖目标前的 DELETE）之前拒绝无效 Depth。
	// RFC 4918 的 ABNF 字面量按 RFC 5234 大小写不敏感，Infinity 与 infinity 等价。
	let collectionDepth = 'infinity';
	if (resource.isCollection) {
		let normalizedDepth = normalizeDepthHeader(request.headers.get('Depth') ?? 'infinity');
		if (normalizedDepth === null || (normalizedDepth !== '0' && normalizedDepth !== 'infinity')) {
			return createTextResponse('badRequest');
		}
		collectionDepth = normalizedDepth;
	}

	let parentResponse = await ensureDestinationParentExists(bucket, destination, sidecarConfig);
	if (parentResponse !== null) {
		return parentResponse;
	}

	let destinationObject = await bucket.head(destination);
	let destinationExists = resource.isCollection
		? destinationObject !== null || (await resolveResource(bucket, destination, sidecarConfig)) !== null
		: destinationObject !== null;
	if (overwriteDisabled && destinationExists) {
		return createTextResponse('preconditionFailed');
	}
	let sourcePreconditionResponse = assertIfMatch(request, resource.object);
	if (sourcePreconditionResponse !== null) {
		return sourcePreconditionResponse;
	}
	sourcePreconditionResponse = assertUnmodifiedSince(request, resource.object);
	if (sourcePreconditionResponse !== null) {
		return sourcePreconditionResponse;
	}
	let destinationPreconditionResponse = assertUnmodifiedSince(request, destinationObject);
	if (destinationPreconditionResponse !== null) {
		return destinationPreconditionResponse;
	}

	if (resource.isCollection && destinationExists) {
		// 内部 DELETE 转发原始 If/Lock-Token 头。
		// tagged If 条件引用源路径，在内部 DELETE 的目标 URL 下可能不匹配——
		// 这是已知限制：若目标集合后代被其他客户端锁定且 token 仅出现在 tagged If 中，
		// DELETE 会返回 423，整体操作失败。这属于正确行为（不应静默删除他人锁定资源）。
		let deleteResponse = await handleDelete(
			new Request(new URL(destinationTarget.header), {
				method: 'DELETE',
				headers: buildForwardedDeleteHeaders(request),
			}),
			bucket,
			sidecarConfig,
		);
		if (!deleteResponse.ok) {
			return deleteResponse;
		}
	}

	if (resource.isCollection) {
		return resolveDepthTransfer(collectionDepth, {
			infinity: async () => {
				let transferResponse = await transferCollectionOrNotFound(
					bucket,
					resource.resourcePath,
					destination,
					(object) => stripLockMetadata(object.customMetadata),
					sidecarConfig,
					{ mapSidecar: stripDirectoryLocks },
				);
				return completeTransfer(transferResponse, destinationExists, destination, true);
			},
			'0': async () => {
				// 隐式集合（无 marker）Depth:0 复制无法在不创建 sidecar/marker 的前提下
				// 物化目标空集合，故返回 404 而不是谎报成功（见 directory-sidecar 测试）。
				if (resource.object === null && !destinationExists) {
					return createTextResponse('notFound');
				}
				let copyResponse = await transferCollectionOrNotFound(
					bucket,
					resource.resourcePath,
					destination,
					(object) => stripLockMetadata(object.customMetadata),
					sidecarConfig,
					{ includeDescendants: false, mapSidecar: stripDirectoryLocks },
				);
				return completeTransfer(copyResponse, destinationExists, destination, true);
			},
		});
	}

	// 防御性检查：resolveResource 不会返回 { object: null, isCollection: false }，
	// 此分支实际不可达，但保留用于类型收窄与兜底。
	if (resource.object === null) {
		return createTextResponse('notFound');
	}

	let copyResponse = await transferOrNotFound(
		bucket,
		resource.object,
		destination,
		stripLockMetadata(resource.object.customMetadata),
	);
	return completeTransfer(copyResponse, destinationExists, destination, false);
}

export async function handleMove(
	request: Request,
	bucket: R2Bucket,
	sidecarConfig: SidecarConfig = DEFAULT_SIDECAR_CONFIG,
): Promise<Response> {
	let resourcePath = makeResourcePath(request);
	let overwrite = parseOverwriteHeader(request.headers.get('Overwrite'));
	if (overwrite === null) {
		return createTextResponse('badRequest');
	}
	let destinationTarget = resolveDestinationTarget(request, resourcePath, sidecarConfig);
	if (destinationTarget instanceof Response) {
		return destinationTarget;
	}
	let destination = destinationTarget.path;

	// MOVE 会删除源资源，源集合的每个后代也必须通过锁检查（RFC 4918 §9.9.2）。
	let sourceLockResponse = await assertRecursiveDeletePermission(request, bucket, resourcePath, sidecarConfig);
	if (sourceLockResponse !== null) {
		return sourceLockResponse;
	}
	let destinationLockResponse = await assertLockPermission(request, bucket, destination, sidecarConfig);
	if (destinationLockResponse !== null) {
		return destinationLockResponse;
	}

	let resource = await loadTransferResource(
		bucket,
		resourcePath,
		destination,
		sidecarConfig,
		moveDestinationValidation,
	);
	if (resource instanceof Response) {
		return resource;
	}

	let collectionDepth = 'infinity';
	if (resource.isCollection) {
		let normalizedDepth = normalizeDepthHeader(request.headers.get('Depth') ?? 'infinity');
		if (normalizedDepth === null || (normalizedDepth !== '0' && normalizedDepth !== 'infinity')) {
			return createTextResponse('badRequest');
		}
		collectionDepth = normalizedDepth;
	}

	let parentResponse = await ensureDestinationParentExists(bucket, destination, sidecarConfig);
	if (parentResponse !== null) {
		return parentResponse;
	}

	let destinationObject = await bucket.head(destination);
	let destinationExists = resource.isCollection
		? destinationObject !== null || (await resolveResource(bucket, destination, sidecarConfig)) !== null
		: destinationObject !== null;
	if (!overwrite && destinationExists) {
		return createTextResponse('preconditionFailed');
	}
	let sourcePreconditionResponse = assertIfMatch(request, resource.object);
	if (sourcePreconditionResponse !== null) {
		return sourcePreconditionResponse;
	}
	sourcePreconditionResponse = assertUnmodifiedSince(request, resource.object);
	if (sourcePreconditionResponse !== null) {
		return sourcePreconditionResponse;
	}
	let destinationPreconditionResponse = assertUnmodifiedSince(request, destinationObject);
	if (destinationPreconditionResponse !== null) {
		return destinationPreconditionResponse;
	}

	if (destinationExists) {
		// 见 handleCopy 中同段注释：内部 DELETE 转发原始锁头，tagged If 可能不匹配目标路径。
		let deleteResponse = await handleDelete(
			new Request(new URL(destinationTarget.header), {
				method: 'DELETE',
				headers: buildForwardedDeleteHeaders(request),
			}),
			bucket,
			sidecarConfig,
		);
		if (!deleteResponse.ok) {
			return deleteResponse;
		}
	}

	if (resource.isCollection) {
		// RFC 4918 §9.8: 集合的 MOVE 无论 Depth 头为何都按 infinity 处理。
		let transferInfinity = async () => {
			let transferResponse = await transferCollectionOrNotFound(
				bucket,
				resource.resourcePath,
				destination,
				(object, targetKey) =>
					rewriteLockRoots(getPreservedCustomMetadata(object.customMetadata), targetKey, isCollectionObject(object)),
				sidecarConfig,
				{
					deleteSource: true,
					mapSidecar: (sidecar, destinationResourcePath) => ({
						...sidecar,
						locks: sidecar.locks?.map((lockDetail) => ({
							...lockDetail,
							root: getResourceHref(destinationResourcePath, true),
						})),
					}),
				},
			);
			return completeTransfer(transferResponse, destinationExists, destination, true);
		};
		return resolveDepthTransfer(collectionDepth, {
			infinity: transferInfinity,
			'0': transferInfinity,
		});
	}

	// 防御性检查：同 handleCopy，实际不可达，保留用于类型收窄与兜底。
	if (resource.object === null) {
		return createTextResponse('notFound');
	}

	let moveResponse = await transferOrNotFound(
		bucket,
		resource.object,
		destination,
		rewriteLockRoots(getPreservedCustomMetadata(resource.object.customMetadata), destination, false),
		{ deleteSource: true },
	);
	return completeTransfer(moveResponse, destinationExists, destination, false);
}
