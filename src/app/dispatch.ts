import { DAV_CLASS, SUPPORT_METHODS } from '../shared/constants';
import { createTextResponse } from '../webdav/responses';
import { handleDelete, handleGet, handleHead, handleMkcol, handlePut } from '../webdav/http/handlers';
import { handleCopy, handleLock, handleMove, handlePropfind, handleProppatch, handleUnlock } from '../webdav/index.js';
import { isReservedWebdavNamespace, makeResourcePath } from '../domain/path';

type MethodHandler = (request: Request, bucket: R2Bucket) => Promise<Response>;

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

export async function dispatchHandler(request: Request, bucket: R2Bucket): Promise<Response> {
	let resourcePath = makeResourcePath(request);
	if (isReservedWebdavNamespace(resourcePath)) {
		return createTextResponse('badRequest');
	}

	if (request.method === 'OPTIONS') {
		return optionsResponse();
	}

	let handler = METHOD_HANDLERS[request.method];
	return handler ? handler(request, bucket) : methodNotAllowedResponse();
}
