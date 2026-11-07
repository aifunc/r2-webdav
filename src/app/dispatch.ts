import { DAV_CLASS, SUPPORT_METHODS } from '../shared/constants';
import { DEFAULT_SIDECAR_CONFIG } from '../shared/sidecar';
import { createTextResponse } from '../webdav/responses';
import { handleDelete, handleGet, handleHead, handleMkcol, handlePut } from '../webdav/http/handlers';
import { handleCopy, handleLock, handleMove, handlePropfind, handleProppatch, handleUnlock } from '../webdav/index.js';
import { acquireResourceMutationGuards, createGuardAwareBucket, LockMutationGuardLostError } from '../domain/locks';
import {
	InvalidResourcePathError,
	isReservedWebdavNamespace,
	makeResourcePath,
	parseDestinationPath,
} from '../domain/path';
import type { SidecarConfig } from '../shared/types';

type MethodHandler = (
	request: Request,
	bucket: R2Bucket,
	sidecarConfig: SidecarConfig,
	mutationGuard?: DurableObjectNamespace,
) => Promise<Response>;

function buildDavHeaders(): HeadersInit {
	return {
		Allow: SUPPORT_METHODS.join(', '),
		DAV: DAV_CLASS,
	};
}

function optionsResponse(): Response {
	// RFC 9110 §9.3.7: a successful OPTIONS response should be 200 with
	// Content-Length: 0. Some WebDAV clients (e.g. webdav_client 1.2.x used by
	// Bettbox) reject 204 before attempting PUT, so keep this at 200.
	return new Response(null, {
		status: 200,
		headers: { ...buildDavHeaders(), 'Content-Length': '0' },
	});
}

function methodNotAllowedResponse(): Response {
	return new Response('Method Not Allowed', {
		status: 405,
		headers: buildDavHeaders(),
	});
}

export const MUTATING_METHODS = new Set(['PUT', 'DELETE', 'MKCOL', 'PROPPATCH', 'COPY', 'MOVE']);

const METHOD_HANDLERS: Record<string, MethodHandler> = {
	HEAD: handleHead,
	GET: handleGet,
	PUT: handlePut,
	DELETE: handleDelete,
	MKCOL: handleMkcol,
	PROPFIND: handlePropfind,
	PROPPATCH: handleProppatch,
	COPY: handleCopy,
	MOVE: handleMove,
	LOCK: handleLock,
	UNLOCK: handleUnlock,
};

export async function dispatchHandler(
	request: Request,
	bucket: R2Bucket,
	sidecarConfig: SidecarConfig = DEFAULT_SIDECAR_CONFIG,
	mutationGuard?: DurableObjectNamespace,
): Promise<Response> {
	let resourcePath: string;
	try {
		resourcePath = makeResourcePath(request);
	} catch (error) {
		if (error instanceof InvalidResourcePathError) {
			return createTextResponse('badRequest');
		}
		throw error;
	}
	if (isReservedWebdavNamespace(resourcePath, sidecarConfig)) {
		return createTextResponse('badRequest');
	}

	if (request.method === 'OPTIONS') {
		return optionsResponse();
	}

	let handler = METHOD_HANDLERS[request.method];
	if (handler === undefined) {
		return methodNotAllowedResponse();
	}

	if (MUTATING_METHODS.has(request.method)) {
		let resourcePaths = [resourcePath];
		if (request.method === 'COPY' || request.method === 'MOVE') {
			let destinationHeader = request.headers.get('Destination');
			let destinationPath = destinationHeader === null ? null : parseDestinationPath(destinationHeader, request.url);
			if (destinationPath !== null && !isReservedWebdavNamespace(destinationPath, sidecarConfig)) {
				resourcePaths.push(destinationPath);
			}
		}
		let guard = await acquireResourceMutationGuards(bucket, resourcePaths, sidecarConfig, mutationGuard);
		if (guard === 'capacity') {
			return createTextResponse('unavailable');
		}
		if (guard === null) {
			return createTextResponse('locked');
		}
		try {
			if (guard.isLost()) {
				return createTextResponse('unavailable');
			}
			return await handler(request, createGuardAwareBucket(bucket, guard), sidecarConfig, mutationGuard);
		} catch (error) {
			if (error instanceof LockMutationGuardLostError) {
				return createTextResponse('unavailable');
			}
			throw error;
		} finally {
			await guard.release();
		}
	}

	return handler(request, bucket, sidecarConfig, mutationGuard);
}
