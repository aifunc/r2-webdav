import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { parseDirectorySidecar, serializeDirectorySidecar, updateDirectorySidecar } from '../src/domain/directories.js';
import { decodeResourcePath, InvalidResourcePathError } from '../src/domain/path.js';
import { handleDelete, handleGet } from '../src/webdav/http/handlers.js';
import worker from '../src/app/worker.js';
import { dispatchHandler } from '../src/app/dispatch.js';
import { acquireResourceMutationGuard, buildInternalDeleteIfHeader } from '../src/domain/locks.js';
import { handleCopy, handleLock, handleMove, handleProppatch } from '../src/webdav/index.js';
import {
	getDeadPropertyKey,
	parseLockRequest,
	parsePropfindRequest,
	parseProppatchRequest,
} from '../src/webdav/xml.js';
import { normalizeDepthHeader, parseOverwriteHeader } from '../src/webdav/responses.js';

function createObject(key, options = {}) {
	let bodyText = options.bodyText ?? '';
	return {
		key,
		size: new TextEncoder().encode(bodyText).byteLength,
		etag: options.etag ?? createHash('md5').update(bodyText).digest('hex'),
		uploaded: options.uploaded ?? new Date('2024-01-01T00:00:00.000Z'),
		httpMetadata: options.httpMetadata ?? {},
		customMetadata: options.customMetadata ?? {},
		bodyText,
	};
}

function createBucket(objects = []) {
	let objectMap = new Map(objects.map((object) => [object.key, object]));
	let operations = { put: [], delete: [] };

	return {
		objects: objectMap,
		operations,
		async head(key) {
			return objectMap.get(key) ?? null;
		},
		async get(key) {
			let object = objectMap.get(key);
			if (object === undefined) {
				return null;
			}
			let body = new TextEncoder().encode(object.bodyText ?? '');
			return {
				...object,
				body,
				text: async () => object.bodyText ?? '',
			};
		},
		async put(key, body, options = {}) {
			let bodyText = typeof body === 'string' ? body : body instanceof Uint8Array ? new TextDecoder().decode(body) : '';
			operations.put.push({ key, bodyText, options });
			let object = createObject(key, {
				bodyText,
				httpMetadata: options.httpMetadata,
				customMetadata: options.customMetadata,
			});
			objectMap.set(key, object);
			return object;
		},
		async delete(keys) {
			for (let key of Array.isArray(keys) ? keys : [keys]) {
				operations.delete.push(key);
				objectMap.delete(key);
			}
		},
		async list(options = {}) {
			let prefix = options.prefix ?? '';
			let matches = [...objectMap.values()].filter((object) => object.key.startsWith(prefix));
			if (options.delimiter === undefined) {
				return { objects: matches, truncated: false };
			}
			let objects = [];
			let delimitedPrefixes = new Set();
			for (let object of matches) {
				let remainder = object.key.slice(prefix.length);
				let delimiterIndex = remainder.indexOf(options.delimiter);
				if (delimiterIndex < 0) {
					objects.push(object);
				} else {
					delimitedPrefixes.add(`${prefix}${remainder.slice(0, delimiterIndex + 1)}`);
				}
			}
			return { objects, delimitedPrefixes: [...delimitedPrefixes], truncated: false };
		},
	};
}

function createConditionalBucket(objects = []) {
	let objectMap = new Map(objects.map((object) => [object.key, object]));
	return {
		objects: objectMap,
		async head(key) {
			return objectMap.get(key) ?? null;
		},
		async get(key) {
			let object = objectMap.get(key);
			if (object === undefined) {
				return null;
			}
			let body = new TextEncoder().encode(object.bodyText ?? '');
			return {
				...object,
				body,
				text: async () => object.bodyText ?? '',
			};
		},
		async put(key, body, options = {}) {
			let bodyText = typeof body === 'string' ? body : body instanceof Uint8Array ? new TextDecoder().decode(body) : '';
			let existing = objectMap.get(key);
			if (options.onlyIf?.etagDoesNotMatch === '*' && existing !== undefined) {
				return null;
			}
			if (
				options.onlyIf?.etagMatches !== undefined &&
				(existing === undefined || existing.etag !== options.onlyIf.etagMatches)
			) {
				return null;
			}
			let object = createObject(key, {
				bodyText,
				httpMetadata: options.httpMetadata,
				customMetadata: options.customMetadata,
			});
			objectMap.set(key, object);
			return object;
		},
		async delete(keys) {
			for (let key of Array.isArray(keys) ? keys : [keys]) {
				objectMap.delete(key);
			}
		},
		async list(options = {}) {
			let prefix = options.prefix ?? '';
			return { objects: [...objectMap.values()].filter((object) => object.key.startsWith(prefix)), truncated: false };
		},
	};
}

function request(method, path, headers = {}, body) {
	return new Request(`http://example.com/${path}`, {
		method,
		headers,
		...(body === undefined ? {} : { body }),
	});
}

test('depth and overwrite headers are case-insensitive and reject invalid values', () => {
	assert.equal(normalizeDepthHeader('Infinity'), 'infinity');
	assert.equal(normalizeDepthHeader('0'), '0');
	assert.equal(normalizeDepthHeader('1'), '1');
	assert.equal(normalizeDepthHeader('2'), null);
	assert.equal(parseOverwriteHeader(' f '), false);
	assert.equal(parseOverwriteHeader('T'), true);
	assert.equal(parseOverwriteHeader('maybe'), null);
});

test('decodeResourcePath rejects encoded path separators', () => {
	for (let pathname of ['/%2Fdocs/a.txt', '/docs%2Fa.txt', '/docs%5Ca.txt', '/docs%00/a.txt']) {
		assert.throws(() => decodeResourcePath(pathname), InvalidResourcePathError);
	}
	assert.equal(decodeResourcePath('/docs/a.txt'), 'docs/a.txt');
});

for (let [name, handler, depth] of [
	['COPY', handleCopy, '1'],
	['MOVE', handleMove, '1'],
]) {
	test(`${name} invalid collection depth does not delete destination`, async () => {
		let bucket = createBucket([
			createObject('source/a.txt', { bodyText: 'source-data' }),
			createObject('target/important.txt', { bodyText: 'only-copy' }),
		]);
		let response = await handler(
			request(name, 'source/', { Destination: 'http://example.com/target/', Depth: depth }),
			bucket,
		);

		assert.equal(response.status, 400);
		assert.equal(bucket.objects.has('target/important.txt'), true);
		assert.equal(bucket.objects.has('source/a.txt'), true);
		assert.deepEqual(bucket.operations.delete, []);
	});
}

test('MOVE rejects a collection containing a locked descendant', async () => {
	let lock = {
		token: 'child-token',
		scope: 'exclusive',
		depth: '0',
		timeout: 'Second-3600',
		expiresAt: Date.now() + 3600000,
		root: '/docs/child.txt',
	};
	let bucket = createBucket([
		createObject('docs/unlocked.txt', { bodyText: 'keep' }),
		createObject('docs/child.txt', {
			bodyText: 'locked',
			customMetadata: { lock_records: JSON.stringify([lock]) },
		}),
	]);

	let response = await handleMove(request('MOVE', 'docs/', { Destination: 'http://example.com/moved/' }), bucket);

	assert.equal(response.status, 423);
	assert.deepEqual(bucket.operations.delete, []);
	assert.equal(bucket.objects.has('docs/child.txt'), true);
});

test('stale If and If-Match preconditions block DELETE and PROPPATCH', async () => {
	let deleteBucket = createBucket([createObject('file.txt', { bodyText: 'data' })]);
	let deleteResponse = await handleDelete(request('DELETE', 'file.txt', { If: '(["stale"])' }), deleteBucket);
	assert.equal(deleteResponse.status, 412);
	assert.equal(deleteBucket.objects.has('file.txt'), true);

	let proppatchBucket = createBucket([createObject('file.txt', { bodyText: 'data' })]);
	let proppatchBody =
		'<propertyupdate xmlns="DAV:"><set><prop><displayname>x</displayname></prop></set></propertyupdate>';
	let proppatchResponse = await handleProppatch(
		request('PROPPATCH', 'file.txt', { 'If-Match': '"stale"' }, proppatchBody),
		proppatchBucket,
	);
	assert.equal(proppatchResponse.status, 412);
});

test('prefixed DAV LOCK XML is parsed by namespace', async () => {
	let bucket = createBucket([createObject('file.txt', { bodyText: 'data' })]);
	let body =
		'<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>';
	let response = await handleLock(request('LOCK', 'file.txt', {}, body), bucket);

	assert.equal(response.status, 201);
});

test('worker fails closed when the mutation guard binding is missing', async () => {
	let env = { bucket: createBucket(), AUTH_USERS: 'auditor:secret' };
	for (let [method, body] of [
		['PUT', 'body'],
		['LOCK', '<D:lockinfo xmlns:D="DAV:" />'],
		['UNLOCK', undefined],
	]) {
		let response = await worker.fetch(
			request(method, 'a.txt', { Authorization: `Basic ${btoa('auditor:secret')}` }, body),
			env,
		);
		assert.equal(response.status, 503);
	}
});

test('XML with excessive nesting is rejected', () => {
	let nested = '<a>'.repeat(70) + '</a>'.repeat(70);
	assert.equal(parsePropfindRequest(`<D:propfind xmlns:D="DAV:">${nested}</D:propfind>`), null);
});

test('rootless XML is rejected without throwing', () => {
	for (let body of ['<!-- comment only -->', '<?xml version="1.0"?>']) {
		assert.equal(parsePropfindRequest(body), null);
		assert.equal(parseProppatchRequest(body), null);
	}
});

test('dead property serialization rejects ill-formed processing instructions', () => {
	let invalid = '<propertyupdate xmlns="DAV:"><set><prop><x xmlns="urn:test"><?xml?></x></prop></set></propertyupdate>';
	assert.equal(parseProppatchRequest(invalid), null);

	let valid =
		'<propertyupdate xmlns="DAV:"><set><prop><x xmlns="urn:test"><?xml-stylesheet href="a"?></x></prop></set></propertyupdate>';
	let parsed = parseProppatchRequest(valid);
	assert.equal(parsed?.operations.length, 1);
	assert.match(parsed.operations[0].property.valueXml, /xml-stylesheet/);
});

test('LOCK owner serialization rejects ill-formed processing instructions', () => {
	let invalid =
		'<lockinfo xmlns="DAV:"><lockscope><exclusive/></lockscope><locktype><write/></locktype><owner><?xml?></owner></lockinfo>';
	assert.equal(parseLockRequest(invalid), null);
});

test('directory PROPPATCH applies set and remove in document order', async () => {
	let propertyKey = getDeadPropertyKey('urn:test', 'label');
	let oldProperty = { namespaceURI: 'urn:test', localName: 'label', prefix: 'x', valueXml: 'old' };
	let bucket = createBucket([
		createObject('.__sidecar__/docs.json', {
			bodyText: serializeDirectorySidecar({ kind: 'directory', props: { [propertyKey]: oldProperty } }),
		}),
	]);
	let body =
		'<propertyupdate xmlns="DAV:" xmlns:x="urn:test"><remove><prop><x:label/></prop></remove><set><prop><x:label>new</x:label></prop></set></propertyupdate>';
	let response = await handleProppatch(request('PROPPATCH', 'docs/', {}, body), bucket);

	assert.equal(response.status, 207);
	let stored = parseDirectorySidecar(bucket.objects.get('.__sidecar__/docs.json').bodyText);
	assert.equal(stored.props?.[propertyKey]?.valueXml, 'new');
});

test('directory sidecar first write uses create-if-absent condition', async () => {
	let bucket = createBucket();
	await updateDirectorySidecar(bucket, '.__sidecar__/docs.json', () => ({ kind: 'directory' }));

	assert.deepEqual(bucket.operations.put[0].options.onlyIf, { etagDoesNotMatch: '*' });
});

test('active content is forced to attachment with sandbox CSP', async () => {
	for (let contentType of ['image/svg+xml', 'text/html']) {
		let bucket = createBucket([
			createObject('active.svg', {
				bodyText: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
				httpMetadata: { contentType, contentDisposition: 'inline' },
			}),
		]);
		let response = await handleGet(request('GET', 'active.svg'), bucket);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get('Content-Disposition'), 'attachment');
		assert.match(response.headers.get('Content-Security-Policy') ?? '', /sandbox/);
		assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
	}
});

test('plain text may remain inline', async () => {
	let bucket = createBucket([
		createObject('note.txt', {
			bodyText: 'hello',
			httpMetadata: { contentType: 'text/plain', contentDisposition: 'inline' },
		}),
	]);
	let response = await handleGet(request('GET', 'note.txt'), bucket);
	assert.equal(response.headers.get('Content-Disposition'), 'inline');
});

test('lock mutation guard serializes acquisition and can be released', async () => {
	let bucket = createConditionalBucket();
	let first = await acquireResourceMutationGuard(bucket, 'docs/file.txt');
	assert.ok(first);
	let second = await acquireResourceMutationGuard(bucket, 'docs/file.txt');
	assert.equal(second, null);
	await first.release();
	let third = await acquireResourceMutationGuard(bucket, 'docs/file.txt');
	assert.ok(third);
	await third.release();
});

test('dispatch guards both source and destination for COPY', async () => {
	let bucket = createConditionalBucket();
	let destinationGuard = await acquireResourceMutationGuard(bucket, 'docs/target.txt');
	assert.ok(destinationGuard);
	let response = await dispatchHandler(
		new Request('http://example.com/docs/source.txt', {
			method: 'COPY',
			headers: { Destination: 'http://example.com/docs/target.txt' },
		}),
		bucket,
	);
	assert.equal(response.status, 423);
	await destinationGuard.release();
});

test('mutation guards are sharded by resource path', async () => {
	let bucket = createConditionalBucket();
	let first = await acquireResourceMutationGuard(bucket, 'docs/a.txt');
	assert.ok(first);
	let second = await acquireResourceMutationGuard(bucket, 'docs/b.txt');
	assert.ok(second);
	let siblingParent = await acquireResourceMutationGuard(bucket, 'other/a.txt');
	assert.ok(siblingParent);
	await first.release();
	await second.release();
	await siblingParent.release();

	let parent = await acquireResourceMutationGuard(bucket, 'docs');
	assert.ok(parent);
	let child = await acquireResourceMutationGuard(bucket, 'docs/child.txt');
	assert.equal(child, null);
	await parent.release();
});

test('concurrent file LOCK requests produce one success', async () => {
	let bucket = createConditionalBucket([createObject('file.txt', { bodyText: 'payload' })]);
	let lockBody =
		'<lockinfo xmlns="DAV:"><lockscope><exclusive/></lockscope><locktype><write/></locktype><owner>audit</owner></lockinfo>';
	let makeRequest = () =>
		new Request('http://example.com/file.txt', {
			method: 'LOCK',
			headers: { Depth: '0', Timeout: 'Second-60', 'Content-Type': 'application/xml' },
			body: lockBody,
		});
	let responses = await Promise.all([handleLock(makeRequest(), bucket), handleLock(makeRequest(), bucket)]);
	assert.deepEqual(responses.map((response) => response.status).sort(), [201, 423]);
});

test('COPY evaluates If conditions against the source when overwriting', async () => {
	let source = createObject('source.txt', { bodyText: 'source' });
	let destination = createObject('target.txt', { bodyText: 'target' });
	let bucket = createBucket([source, destination]);
	let etag = source.httpEtag ?? `"${source.etag}"`;
	let response = await handleCopy(
		request('COPY', 'source.txt', {
			Destination: 'http://example.com/target.txt',
			If: `([${etag}])`,
		}),
		bucket,
	);
	assert.equal(response.status, 204);
});

test('COPY collection evaluates If conditions against the source when overwriting', async () => {
	let source = createObject('source', {
		bodyText: '',
		customMetadata: { resourcetype: '<collection />' },
	});
	let destination = createObject('target', {
		bodyText: '',
		customMetadata: { resourcetype: '<collection />' },
	});
	let bucket = createBucket([source, destination]);
	let etag = source.httpEtag ?? `"${source.etag}"`;
	let response = await handleCopy(
		request('COPY', 'source/', {
			Destination: 'http://example.com/target/',
			Depth: '0',
			If: `([${etag}])`,
		}),
		bucket,
	);
	assert.equal(response.status, 204);
});

test('MOVE evaluates If conditions against the source when overwriting', async () => {
	let source = createObject('source.txt', { bodyText: 'source' });
	let destination = createObject('target.txt', { bodyText: 'target' });
	let bucket = createBucket([source, destination]);
	let etag = source.httpEtag ?? `"${source.etag}"`;
	let response = await handleMove(
		request('MOVE', 'source.txt', {
			Destination: 'http://example.com/target.txt',
			If: `([${etag}])`,
		}),
		bucket,
	);
	assert.equal(response.status, 204);
});

test('internal DELETE forwards only lock tokens from If', () => {
	assert.equal(
		buildInternalDeleteIfHeader('(<urn:uuid:token-1>) (["etag-1"])', 'http://example.com/source', 'target'),
		'(<urn:uuid:token-1>)',
	);
	assert.equal(buildInternalDeleteIfHeader('(["etag-1"])', 'http://example.com/source', 'target'), null);
	assert.equal(buildInternalDeleteIfHeader(null, 'http://example.com/source', 'target'), null);
});

test('internal DELETE preserves target-tagged If conditions', () => {
	assert.equal(
		buildInternalDeleteIfHeader('</target> (["target-etag"])', 'http://example.com/source', 'target'),
		'</target>(["target-etag"])',
	);
	assert.equal(buildInternalDeleteIfHeader('</source> (["source-etag"])', 'http://example.com/source', 'target'), null);
});
