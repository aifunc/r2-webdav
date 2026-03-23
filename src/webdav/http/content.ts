import { getCollectionPrefix, getResourceHref, hasTrailingSlashPath, makeResourcePath } from '../../domain/path';
import { listCollectionChildren, resolveResource } from '../../domain/storage';
import { DEFAULT_SIDECAR_CONFIG } from '../../shared/sidecar';
import type { SidecarConfig } from '../../shared/types';
import { escapeXml } from '../xml';
import { buildResourceVersionHeaders, createTextResponse } from './shared';

const OBJECT_RESPONSE_METADATA_HEADERS = [
	{
		key: 'contentDisposition',
		header: 'Content-Disposition',
	},
	{
		key: 'contentEncoding',
		header: 'Content-Encoding',
	},
	{
		key: 'contentLanguage',
		header: 'Content-Language',
	},
	{
		key: 'cacheControl',
		header: 'Cache-Control',
	},
] as const;

function isR2ObjectBody(object: R2Object | R2ObjectBody): object is R2ObjectBody {
	return 'body' in object;
}

function buildObjectResponseHeaders(object: R2ObjectBody, rangeOffset: number, rangeEnd: number): Headers {
	let contentLength = rangeEnd - rangeOffset + 1;
	let headers = new Headers({
		'Accept-Ranges': 'bytes',
		'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
		'Content-Length': contentLength.toString(),
	});
	buildResourceVersionHeaders(object).forEach((value, name) => headers.set(name, value));

	if (object.range !== undefined) {
		headers.set('Content-Range', `bytes ${rangeOffset}-${rangeEnd}/${object.size}`);
	}

	for (let { key, header } of OBJECT_RESPONSE_METADATA_HEADERS) {
		let value = object.httpMetadata?.[key];
		if (value !== undefined) {
			headers.set(header, value);
		}
	}

	if (object.httpMetadata?.cacheExpiry) {
		headers.set('Cache-Expiry', object.httpMetadata.cacheExpiry.toISOString());
	}

	return headers;
}

function renderDirectoryListingLink(href: string, label: string): string {
	return `<a href="${escapeXml(href)}">${escapeXml(label)}</a><br>`;
}

function renderDirectoryListingPage(page: string): string {
	return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>R2Storage</title><style>*{box-sizing:border-box;}body{padding:10px;font-family:'Segoe UI','Circular','Roboto','Lato','Helvetica Neue','Arial Rounded MT Bold','sans-serif';}a{display:inline-block;width:100%;color:#000;text-decoration:none;padding:5px 10px;cursor:pointer;border-radius:5px;}a:hover{background-color:#60C590;color:white;}a[href="../"]{background-color:#cbd5e1;}</style></head><body><h1>R2 Storage</h1><div>${page}</div></body></html>`;
}

function calcContentRange(object: R2ObjectBody): { rangeOffset: number; rangeEnd: number } {
	let rangeOffset = 0;
	let rangeEnd = object.size - 1;
	if (object.range) {
		if ('suffix' in object.range && object.range.suffix !== undefined) {
			rangeOffset = Math.max(object.size - object.range.suffix, 0);
		} else if ('offset' in object.range || 'length' in object.range) {
			rangeOffset = object.range.offset ?? 0;
			let length = object.range.length ?? object.size - rangeOffset;
			rangeEnd = Math.min(rangeOffset + length - 1, object.size - 1);
		}
	}

	return { rangeOffset, rangeEnd };
}

async function renderDirectoryListing(
	bucket: R2Bucket,
	resourcePath: string,
	sidecarConfig: SidecarConfig,
): Promise<Response> {
	if (resourcePath !== '') {
		let resolved = await resolveResource(bucket, resourcePath, sidecarConfig);
		if (resolved === null || !resolved.isCollection) {
			return createTextResponse('notFound');
		}
	}

	let prefix = resourcePath === '' ? resourcePath : getCollectionPrefix(resourcePath);
	let links = resourcePath === '' ? [] : [renderDirectoryListingLink('../', '..')];

	for await (let entry of listCollectionChildren(bucket, resourcePath, sidecarConfig)) {
		let href = getResourceHref(entry.key, entry.isCollection);
		let label = entry.key.slice(prefix.length);
		links.push(renderDirectoryListingLink(href, label));
	}

	return new Response(renderDirectoryListingPage(links.join('')), {
		status: 200,
		headers: { 'Content-Type': 'text/html; charset=utf-8' },
	});
}

export async function handleHead(
	request: Request,
	bucket: R2Bucket,
	sidecarConfig: SidecarConfig = DEFAULT_SIDECAR_CONFIG,
): Promise<Response> {
	let response = await handleGet(request, bucket, sidecarConfig);
	return new Response(null, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

export async function handleGet(
	request: Request,
	bucket: R2Bucket,
	sidecarConfig: SidecarConfig = DEFAULT_SIDECAR_CONFIG,
): Promise<Response> {
	let resourcePath = makeResourcePath(request);

	if (hasTrailingSlashPath(request)) {
		return renderDirectoryListing(bucket, resourcePath, sidecarConfig);
	}

	let object = await bucket.get(resourcePath, {
		onlyIf: request.headers,
		range: request.headers,
	});

	if (object === null) {
		return createTextResponse('notFound');
	}
	if (!isR2ObjectBody(object)) {
		return createTextResponse('preconditionFailed');
	}

	let { rangeOffset, rangeEnd } = calcContentRange(object);
	return new Response(object.body, {
		status: object.range !== undefined ? 206 : 200,
		headers: buildObjectResponseHeaders(object, rangeOffset, rangeEnd),
	});
}
