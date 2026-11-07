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

const INLINE_SAFE_CONTENT_TYPES = new Set(['text/plain', 'text/csv', 'application/pdf', 'application/json']);
const INLINE_SAFE_CONTENT_TYPE_PREFIXES = ['image/', 'audio/', 'video/'];
const ACTIVE_CONTENT_TYPES = new Set([
	'text/html',
	'application/xhtml+xml',
	'image/svg+xml',
	'application/xml',
	'text/xml',
	'application/javascript',
	'text/javascript',
	'application/x-javascript',
	'application/rss+xml',
	'application/atom+xml',
]);

function getBaseContentType(contentType: string | undefined): string | undefined {
	return contentType?.split(';')[0]?.trim().toLowerCase();
}

function isActiveContentType(contentType: string | undefined): boolean {
	let base = getBaseContentType(contentType);
	return base !== undefined && (ACTIVE_CONTENT_TYPES.has(base) || base.endsWith('+xml'));
}

function isInlineSafeContentType(contentType: string | undefined): boolean {
	let base = getBaseContentType(contentType);
	if (base === undefined || isActiveContentType(base)) {
		return false;
	}
	if (INLINE_SAFE_CONTENT_TYPE_PREFIXES.some((prefix) => base.startsWith(prefix))) {
		return true;
	}
	return INLINE_SAFE_CONTENT_TYPES.has(base);
}

function isR2ObjectBody(object: R2Object | R2ObjectBody): object is R2ObjectBody {
	return 'body' in object;
}

function buildObjectResponseHeaders(
	object: R2ObjectBody,
	rangeOffset: number,
	rangeEnd: number,
	partial: boolean,
): Headers {
	let contentLength = rangeEnd - rangeOffset + 1;
	let headers = new Headers({
		'Accept-Ranges': 'bytes',
		'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
		'Content-Length': contentLength.toString(),
	});
	buildResourceVersionHeaders(object).forEach((value, name) => headers.set(name, value));

	if (partial) {
		headers.set('Content-Range', `bytes ${rangeOffset}-${rangeEnd}/${object.size}`);
	}

	for (let { key, header } of OBJECT_RESPONSE_METADATA_HEADERS) {
		let value = object.httpMetadata?.[key];
		if (value !== undefined) {
			headers.set(header, value);
		}
	}

	headers.set('X-Content-Type-Options', 'nosniff');

	if (isActiveContentType(object.httpMetadata?.contentType)) {
		// 上传的 SVG/HTML/XML 可能携带脚本。即使客户端上传了 inline disposition，
		// 也必须强制下载，并附加 sandbox CSP 作为第二道防线。
		headers.set('Content-Disposition', 'attachment');
		headers.set('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'");
	} else if (
		object.httpMetadata?.contentDisposition === undefined &&
		!isInlineSafeContentType(object.httpMetadata?.contentType)
	) {
		headers.set('Content-Disposition', 'attachment');
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

type ByteRange = {
	first: number | null;
	last: number | null;
};

// 返回 null 表示没有 Range 头，undefined 表示语法无效/不支持（按 RFC 9110 忽略它）。
function parseByteRangeHeader(header: string | null): ByteRange | null | undefined {
	if (header === null) {
		return null;
	}

	let match = /^bytes=(.+)$/i.exec(header.trim());
	if (match === null) {
		return undefined;
	}

	let spec = match[1].trim();
	if (spec.includes(',')) {
		return undefined;
	}

	let parts = /^(\d*)-(\d*)$/.exec(spec);
	if (parts === null) {
		return undefined;
	}

	let firstText = parts[1] ?? '';
	let lastText = parts[2] ?? '';
	if (firstText === '' && lastText === '') {
		return undefined;
	}

	if (firstText === '') {
		let suffix = Number(lastText);
		return Number.isSafeInteger(suffix) ? { first: null, last: suffix } : undefined;
	}

	let first = Number(firstText);
	if (!Number.isSafeInteger(first)) {
		return undefined;
	}
	if (lastText === '') {
		return { first, last: null };
	}

	let last = Number(lastText);
	if (!Number.isSafeInteger(last) || last < first) {
		return undefined;
	}

	return { first, last };
}

function resolveByteRange(range: ByteRange, size: number): { offset: number; length: number } | null {
	if (range.first === null) {
		let suffix = range.last ?? 0;
		if (suffix === 0 || size === 0) {
			return null;
		}
		let length = Math.min(suffix, size);
		return { offset: size - length, length };
	}

	if (size === 0 || range.first >= size) {
		return null;
	}

	let end = range.last === null ? size - 1 : Math.min(range.last, size - 1);
	return { offset: range.first, length: end - range.first + 1 };
}

type IfRangeValidator = { etag: string } | { date: number };

function parseIfRangeHeader(header: string | null): IfRangeValidator | null {
	if (header === null) {
		return null;
	}

	let value = header.trim();
	if (value === '') {
		return null;
	}
	if (value.startsWith('"') || value.startsWith('W/')) {
		return { etag: value };
	}

	let timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? { date: timestamp } : null;
}

function ifRangeMatches(
	validator: IfRangeValidator,
	resource: Pick<R2Object, 'etag' | 'httpEtag' | 'uploaded'>,
): boolean {
	if ('etag' in validator) {
		if (validator.etag.startsWith('W/')) {
			return false;
		}
		return validator.etag === (resource.httpEtag || `"${resource.etag}"`);
	}

	return Math.floor(resource.uploaded.getTime() / 1000) <= Math.floor(validator.date / 1000);
}

async function negotiateRequestRange(
	request: Request,
	bucket: R2Bucket,
	resourcePath: string,
): Promise<{ range: ByteRange | null; missing: boolean }> {
	let range = parseByteRangeHeader(request.headers.get('Range'));
	if (range === undefined) {
		range = null;
	}

	let validator = range === null ? null : parseIfRangeHeader(request.headers.get('If-Range'));
	if (range !== null && validator !== null) {
		let meta = await bucket.head(resourcePath);
		if (meta === null) {
			return { range: null, missing: true };
		}
		if (!ifRangeMatches(validator, meta)) {
			range = null;
		}
	}

	return { range, missing: false };
}

function buildGetOptions(request: Request, range: ByteRange | null): R2GetOptions {
	return range === null ? { onlyIf: request.headers } : { onlyIf: request.headers, range: request.headers };
}

function getUnsatisfiableRangeResponse(size: number): Response {
	return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
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
	let resourcePath = makeResourcePath(request);

	if (hasTrailingSlashPath(request)) {
		if (resourcePath !== '') {
			let resolved = await resolveResource(bucket, resourcePath, sidecarConfig);
			if (resolved === null || !resolved.isCollection) {
				return createTextResponse('notFound');
			}
		}
		return new Response(null, {
			status: 200,
			headers: { 'Content-Type': 'text/html; charset=utf-8' },
		});
	}

	let hasConditionals =
		request.headers.has('If-None-Match') ||
		request.headers.has('If-Modified-Since') ||
		request.headers.has('If-Match') ||
		request.headers.has('If-Unmodified-Since');

	if (!hasConditionals && !request.headers.has('Range')) {
		let object = await bucket.head(resourcePath);
		if (object === null) {
			return createTextResponse('notFound');
		}
		return new Response(null, {
			status: 200,
			headers: buildObjectResponseHeaders(object as R2ObjectBody, 0, object.size - 1, false),
		});
	}

	let { range, missing } = await negotiateRequestRange(request, bucket, resourcePath);
	if (missing) {
		return createTextResponse('notFound');
	}

	let object = await bucket.get(resourcePath, buildGetOptions(request, range));
	if (object === null) {
		if (range === null) {
			return createTextResponse('notFound');
		}
		let meta = await bucket.head(resourcePath);
		if (meta === null) {
			return createTextResponse('notFound');
		}
		if (resolveByteRange(range, meta.size) === null) {
			return getUnsatisfiableRangeResponse(meta.size);
		}
		return createTextResponse('preconditionFailed');
	}
	if (!isR2ObjectBody(object)) {
		if (request.headers.has('If-None-Match') || request.headers.has('If-Modified-Since')) {
			return new Response(null, { status: 304, headers: buildResourceVersionHeaders(object) });
		}
		return createTextResponse('preconditionFailed');
	}

	let partial = false;
	let { rangeOffset, rangeEnd } = calcContentRange(object);
	if (range !== null) {
		if (resolveByteRange(range, object.size) === null) {
			return getUnsatisfiableRangeResponse(object.size);
		}
		partial = object.range !== undefined;
	}
	if (!partial) {
		rangeOffset = 0;
		rangeEnd = object.size - 1;
	}

	return new Response(null, {
		status: partial ? 206 : 200,
		headers: buildObjectResponseHeaders(object, rangeOffset, rangeEnd, partial),
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

	let { range, missing } = await negotiateRequestRange(request, bucket, resourcePath);
	if (missing) {
		return createTextResponse('notFound');
	}

	let object = await bucket.get(resourcePath, buildGetOptions(request, range));

	if (object === null) {
		if (range === null) {
			return createTextResponse('notFound');
		}
		let meta = await bucket.head(resourcePath);
		if (meta === null) {
			return createTextResponse('notFound');
		}
		if (resolveByteRange(range, meta.size) === null) {
			return getUnsatisfiableRangeResponse(meta.size);
		}
		return createTextResponse('preconditionFailed');
	}
	if (!isR2ObjectBody(object)) {
		if (request.headers.has('If-None-Match') || request.headers.has('If-Modified-Since')) {
			return new Response(null, { status: 304, headers: buildResourceVersionHeaders(object) });
		}
		return createTextResponse('preconditionFailed');
	}

	let partial = false;
	let { rangeOffset, rangeEnd } = calcContentRange(object);
	if (range !== null) {
		if (resolveByteRange(range, object.size) === null) {
			return getUnsatisfiableRangeResponse(object.size);
		}
		partial = object.range !== undefined;
	}
	if (!partial) {
		rangeOffset = 0;
		rangeEnd = object.size - 1;
	}

	return new Response(object.body, {
		status: partial ? 206 : 200,
		headers: buildObjectResponseHeaders(object, rangeOffset, rangeEnd, partial),
	});
}
