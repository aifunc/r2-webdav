import { DAV_CLASS, SUPPORT_METHODS } from '../shared/constants';
import { DEFAULT_SIDECAR_CONFIG } from '../shared/sidecar';
import { createTextResponse } from '../webdav/responses';
import { handleDelete, handleGet, handleHead, handleMkcol, handlePut } from '../webdav/http/handlers';
import { handleCopy, handleLock, handleMove, handlePropfind, handleProppatch, handleUnlock } from '../webdav/index.js';
import { acquireResourceMutationGuards } from '../domain/locks';
import {
	InvalidResourcePathError,
	isReservedWebdavNamespace,
	makeResourcePath,
	parseDestinationPath,
} from '../domain/path';
import type { SidecarConfig } from '../shared/types';

type MethodHandler = (request: Request, bucket: R2Bucket, sidecarConfig: SidecarConfig) => Promise<Response>;

function buildDavHeaders(): HeadersInit {
	return {
		Allow: SUPPORT_METHODS.join(', '),
		DAV: DAV_CLASS,
	};
}

function optionsResponse(): Response {
	return new Response(null, {
		status: 204,
		headers: buildDavHeaders(),
	});
}

function methodNotAllowedResponse(): Response {
	return new Response('Method Not Allowed', {
		status: 405,
		headers: buildDavHeaders(),
	});
}

const MUTATING_METHODS = new Set(['PUT', 'DELETE', 'MKCOL', 'PROPPATCH', 'COPY', 'MOVE']);

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
		let guard = await acquireResourceMutationGuards(bucket, resourcePaths, sidecarConfig);
		if (guard === null) {
			return createTextResponse('locked');
		}
		try {
			return await handler(request, bucket, sidecarConfig);
		} finally {
			await guard.release();
		}
	}

	return handler(request, bucket, sidecarConfig);
}
