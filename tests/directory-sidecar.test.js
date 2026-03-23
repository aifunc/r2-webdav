import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	getDirectorySidecarKey,
	isDirectorySidecarKey,
	isReservedWebdavPath,
	parseDirectorySidecar,
	serializeDirectorySidecar,
	readLegacyDirectoryMarker,
	coalesceDirectoryMetadata,
	getLegacyDirectoryMigrationPlan,
} from '../src/domain/directories.js';
import { dispatchHandler } from '../src/app/dispatch.js';
import { handleDelete, handleGet, handleMkcol, handlePut } from '../src/webdav/http/handlers.js';
import {
	handleCopy,
	handleLock,
	handleMove,
	handlePropfind,
	handleProppatch,
	handleUnlock,
} from '../src/webdav/index.js';

const LOCK_DETAIL_SAMPLE = {
	token: 'lock-token',
	owner: 'owner',
	scope: 'exclusive',
	depth: 'infinity',
	timeout: 'Second-60',
	expiresAt: 2_500_000_000_000,
	root: '/',
};

const DEAD_PROPERTY_KEY = `dead_property:${encodeURIComponent('DAV:')}:${encodeURIComponent('displayname')}`;
const DISPLAYNAME_PROPERTY = {
	namespaceURI: 'DAV:',
	localName: 'displayname',
	prefix: null,
	valueXml: 'Legacy',
};
const UPDATED_DISPLAYNAME_PROPERTY = {
	...DISPLAYNAME_PROPERTY,
	valueXml: 'Updated',
};
const SIDECAR_DISPLAYNAME_PROPERTY = {
	...DISPLAYNAME_PROPERTY,
	valueXml: 'Sidecar',
};
const CUSTOM_DEAD_PROPERTY_KEY = `dead_property:${encodeURIComponent('urn:example')}:${encodeURIComponent('custom')}`;
const CUSTOM_DEAD_PROPERTY = {
	namespaceURI: 'urn:example',
	localName: 'custom',
	prefix: null,
	valueXml: 'LegacyCustom',
};

test('generates directory sidecar key for resource paths', () => {
	assert.equal(getDirectorySidecarKey('docs/collections'), '.__webdav__/directories/docs/collections.json');
	assert.equal(getDirectorySidecarKey(''), '.__webdav__/directories/.json');
});

test('detects sidecar object keys under __webdav__/directories', () => {
	assert.equal(isDirectorySidecarKey('.__webdav__/directories/docs.json'), true);
	assert.equal(isDirectorySidecarKey('docs/__webdav__/directories.json'), false);
});

test('detects reserved __webdav__ namespace paths', () => {
	assert.equal(isReservedWebdavPath('.__webdav__/directories/docs.json'), true);
	assert.equal(isReservedWebdavPath('docs/.__webdav__/directories.json'), false);
});

const SIDE_CAR_PROPS = { [DEAD_PROPERTY_KEY]: DISPLAYNAME_PROPERTY };

test('parses valid directory sidecar JSON', () => {
	const payload = JSON.stringify({
		kind: 'directory',
		props: SIDE_CAR_PROPS,
		locks: [LOCK_DETAIL_SAMPLE],
	});

	const parsed = parseDirectorySidecar(payload);
	assert.deepStrictEqual(parsed, {
		kind: 'directory',
		props: SIDE_CAR_PROPS,
		locks: [LOCK_DETAIL_SAMPLE],
	});
});

test('parseDirectorySidecar returns undefined for malformed JSON', () => {
	assert.equal(parseDirectorySidecar('{"kind":'), undefined);
	assert.equal(parseDirectorySidecar('["not", "an", "object"]'), undefined);
});

test('serializes and parses directory sidecar JSON', () => {
	const sidecar = {
		kind: 'directory',
		props: SIDE_CAR_PROPS,
		locks: [],
	};
	const payload = serializeDirectorySidecar(sidecar);
	assert.deepStrictEqual(parseDirectorySidecar(payload), sidecar);
});

test('reads legacy directory marker metadata from stored metadata', () => {
	const metadata = {
		resourcetype: '<collection />',
		[DEAD_PROPERTY_KEY]: JSON.stringify(DISPLAYNAME_PROPERTY),
		lock_records: JSON.stringify([LOCK_DETAIL_SAMPLE]),
	};

	const legacy = readLegacyDirectoryMarker(metadata);
	assert.deepStrictEqual(legacy, {
		props: SIDE_CAR_PROPS,
		locks: [LOCK_DETAIL_SAMPLE],
	});
});

test('readLegacyDirectoryMarker returns undefined for invalid metadata', () => {
	const metadata = {
		[DEAD_PROPERTY_KEY]: JSON.stringify(DISPLAYNAME_PROPERTY),
	};

	assert.equal(readLegacyDirectoryMarker(metadata), undefined);
});

test('reads empty legacy marker when only resourcetype is set', () => {
	const metadata = {
		resourcetype: '<collection />',
	};

	assert.deepStrictEqual(readLegacyDirectoryMarker(metadata), {
		props: undefined,
		locks: undefined,
	});
});

test('falls back to legacy marker metadata when no sidecar exists', () => {
	const metadata = {
		resourcetype: '<collection />',
		[DEAD_PROPERTY_KEY]: JSON.stringify(DISPLAYNAME_PROPERTY),
		lock_records: JSON.stringify([LOCK_DETAIL_SAMPLE]),
	};

	const legacy = readLegacyDirectoryMarker(metadata);
	assert.ok(legacy);

	const resolved = coalesceDirectoryMetadata(undefined, legacy);
	assert.deepStrictEqual(resolved, {
		kind: 'directory',
		props: legacy.props,
		locks: legacy.locks,
	});
});

test('prefers sidecar metadata when sidecar and legacy marker both exist', () => {
	const sidecar = {
		kind: 'directory',
		props: SIDE_CAR_PROPS,
		locks: [],
	};
	const legacy = {
		props: SIDE_CAR_PROPS,
		locks: [LOCK_DETAIL_SAMPLE],
	};

	const resolved = coalesceDirectoryMetadata(sidecar, legacy);
	assert.deepStrictEqual(resolved, sidecar);
});

test('migration plan creates a sidecar when only the legacy marker exists', () => {
	const legacy = {
		props: SIDE_CAR_PROPS,
		locks: [LOCK_DETAIL_SAMPLE],
	};

	assert.deepStrictEqual(getLegacyDirectoryMigrationPlan(undefined, legacy), {
		action: 'write-sidecar',
		sidecar: {
			kind: 'directory',
			props: SIDE_CAR_PROPS,
			locks: [LOCK_DETAIL_SAMPLE],
		},
	});
});

test('migration plan deletes the legacy marker when an equivalent sidecar already exists', () => {
	const legacy = {
		props: SIDE_CAR_PROPS,
		locks: [LOCK_DETAIL_SAMPLE],
	};
	const existingSidecar = {
		kind: 'directory',
		props: SIDE_CAR_PROPS,
		locks: [LOCK_DETAIL_SAMPLE],
	};

	assert.deepStrictEqual(getLegacyDirectoryMigrationPlan(existingSidecar, legacy), {
		action: 'delete-legacy-marker',
	});
});

test('migration plan reports a conflict when the existing sidecar differs from legacy metadata', () => {
	const legacy = {
		props: SIDE_CAR_PROPS,
		locks: [LOCK_DETAIL_SAMPLE],
	};
	const existingSidecar = {
		kind: 'directory',
		props: { [DEAD_PROPERTY_KEY]: UPDATED_DISPLAYNAME_PROPERTY },
		locks: [LOCK_DETAIL_SAMPLE],
	};

	assert.deepStrictEqual(getLegacyDirectoryMigrationPlan(existingSidecar, legacy), {
		action: 'conflict',
	});
});

const RESERVED_URL = 'http://example.com/.__webdav__/sidecar';
const RESERVED_ROOT_URL = 'http://example.com/.__webdav__';
const VALID_DESTINATION_URL = 'http://example.com/not-reserved';
const BAD_REQUEST_BODY = 'Bad Request';

function createObject(key, options = {}) {
	return {
		key,
		size: options.size ?? 1,
		etag: 'etag',
		uploaded: new Date('2024-01-01T00:00:00.000Z'),
		httpMetadata: options.httpMetadata ?? {},
		customMetadata: options.customMetadata ?? {},
		bodyText: options.bodyText,
	};
}

function createListingBucket(objects) {
	const objectMap = new Map(objects.map((object) => [object.key, object]));

	return {
		async head(key) {
			return objectMap.get(key) ?? null;
		},
		async get(key) {
			const object = objectMap.get(key);
			if (!object) {
				return null;
			}
			const bodyText = object.bodyText ?? '';
			return {
				body: new TextEncoder().encode(bodyText),
				text: async () => bodyText,
				httpMetadata: object.httpMetadata,
				customMetadata: object.customMetadata,
				size: object.size,
				etag: object.etag,
				uploaded: object.uploaded,
			};
		},
		async put() {},
		async delete() {},
		async list(options = {}) {
			const prefix = options.prefix ?? '';
			const delimiter = options.delimiter;
			const matches = [...objectMap.values()].filter((object) => object.key.startsWith(prefix));

			if (!delimiter) {
				return { objects: matches, truncated: false };
			}

			const objects = [];
			const delimitedPrefixes = new Set();

			for (const object of matches) {
				const remainder = object.key.slice(prefix.length);
				if (remainder === '') {
					objects.push(object);
					continue;
				}

				const delimiterIndex = remainder.indexOf(delimiter);
				if (delimiterIndex === -1) {
					objects.push(object);
				} else {
					delimitedPrefixes.add(`${prefix}${remainder.slice(0, delimiterIndex + 1)}`);
				}
			}

			return {
				objects,
				delimitedPrefixes: [...delimitedPrefixes],
				truncated: false,
			};
		},
	};
}

function createTrackingBucket(objects = []) {
	const objectMap = new Map(objects.map((object) => [object.key, { ...object }]));
	const operations = { put: [], delete: [] };

	return {
		objects: objectMap,
		operations,
		async head(key) {
			return objectMap.get(key) ?? null;
		},
		async get(key) {
			const object = objectMap.get(key);
			if (!object) {
				return null;
			}
			const bodyText = object.bodyText ?? '';
			return {
				body: new TextEncoder().encode(bodyText),
				text: async () => bodyText,
				httpMetadata: object.httpMetadata ?? {},
				customMetadata: object.customMetadata ?? {},
				size: object.size ?? 0,
				etag: object.etag ?? 'etag',
				uploaded: object.uploaded ?? new Date('2024-01-01T00:00:00.000Z'),
			};
		},
		async put(key, body, options = {}) {
			let bodyText = '';
			if (typeof body === 'string') {
				bodyText = body;
			} else if (body instanceof Uint8Array) {
				bodyText = new TextDecoder().decode(body);
			} else if (body instanceof ArrayBuffer) {
				bodyText = new TextDecoder().decode(new Uint8Array(body));
			}
			operations.put.push({ key, bodyText, options });
			objectMap.set(
				key,
				createObject(key, { bodyText, httpMetadata: options.httpMetadata, customMetadata: options.customMetadata }),
			);
		},
		async delete(keys) {
			const deleteKeys = Array.isArray(keys) ? keys : [keys];
			for (const key of deleteKeys) {
				operations.delete.push(key);
				objectMap.delete(key);
			}
		},
		async list(options = {}) {
			const prefix = options.prefix ?? '';
			const delimiter = options.delimiter;
			const matches = [...objectMap.values()].filter((object) => object.key.startsWith(prefix));

			if (!delimiter) {
				return { objects: matches, truncated: false };
			}

			const objects = [];
			const delimitedPrefixes = new Set();

			for (const object of matches) {
				const remainder = object.key.slice(prefix.length);
				if (remainder === '') {
					objects.push(object);
					continue;
				}

				const delimiterIndex = remainder.indexOf(delimiter);
				if (delimiterIndex === -1) {
					objects.push(object);
				} else {
					delimitedPrefixes.add(`${prefix}${remainder.slice(0, delimiterIndex + 1)}`);
				}
			}

			return {
				objects,
				delimitedPrefixes: [...delimitedPrefixes],
				truncated: false,
			};
		},
	};
}

function createDummyBucket() {
	return {
		head: async () => null,
		get: async () => null,
		put: async () => {},
		delete: async () => {},
		list: async () => ({ objects: [], truncated: false }),
	};
}

function createFailingBucket() {
	const failure = async () => {
		throw new Error('Bucket should not be used when reserved destination is rejected');
	};

	return {
		head: failure,
		get: failure,
		put: failure,
		delete: failure,
		list: failure,
	};
}

function makeReservedRequest(method, options = {}) {
	return new Request(RESERVED_URL, { method, ...options });
}

const RESERVED_METHODS = [
	{ method: 'GET' },
	{ method: 'OPTIONS' },
	{ method: 'PUT', body: 'data' },
	{ method: 'MKCOL' },
	{
		method: 'PROPPATCH',
		body: '<?xml version="1.0" encoding="utf-8"?>\n<propertyupdate xmlns="DAV:"><set><prop><displayname>name</displayname></prop></set></propertyupdate>',
		headers: { 'Content-Type': 'application/xml' },
	},
	{
		method: 'LOCK',
		body: '<?xml version="1.0" encoding="utf-8"?><lockinfo xmlns="DAV:"><lockscope><exclusive/></lockscope><locktype><write/></locktype><owner><href>owner</href></owner></lockinfo>',
		headers: { 'Content-Type': 'application/xml' },
	},
	{ method: 'COPY', headers: { Destination: VALID_DESTINATION_URL } },
	{ method: 'MOVE', headers: { Destination: VALID_DESTINATION_URL } },
];

async function assertBadRequestResponse(response) {
	assert.equal(response.status, 400);
	const body = await response.text();
	assert.equal(body, BAD_REQUEST_BODY);
}

for (const { method, body, headers } of RESERVED_METHODS) {
	test(`${method} request path rejects reserved namespace`, async () => {
		const request = makeReservedRequest(method, { body, headers });
		const response = await dispatchHandler(request, createDummyBucket());
		await assertBadRequestResponse(response);
	});
}

test('GET request root path rejects reserved namespace', async () => {
	const request = new Request(RESERVED_ROOT_URL, { method: 'GET' });
	const response = await dispatchHandler(request, createDummyBucket());
	await assertBadRequestResponse(response);
});

test('COPY rejects reserved destination paths before bucket work', async () => {
	const request = new Request('http://example.com/allowed', {
		method: 'COPY',
		headers: {
			Destination: 'http://example.com/.__webdav__/internal',
		},
	});
	const response = await handleCopy(request, createFailingBucket());
	await assertBadRequestResponse(response);
});

test('MOVE rejects reserved destination paths before bucket work', async () => {
	const request = new Request('http://example.com/allowed', {
		method: 'MOVE',
		headers: {
			Destination: 'http://example.com/.__webdav__/internal',
		},
	});
	const response = await handleMove(request, createFailingBucket());
	await assertBadRequestResponse(response);
});

test('COPY rejects exact-root reserved destination before bucket work', async () => {
	const request = new Request('http://example.com/allowed', {
		method: 'COPY',
		headers: {
			Destination: RESERVED_ROOT_URL,
		},
	});
	const response = await handleCopy(request, createFailingBucket());
	await assertBadRequestResponse(response);
});

test('MOVE rejects exact-root reserved destination before bucket work', async () => {
	const request = new Request('http://example.com/allowed', {
		method: 'MOVE',
		headers: {
			Destination: RESERVED_ROOT_URL,
		},
	});
	const response = await handleMove(request, createFailingBucket());
	await assertBadRequestResponse(response);
});

test('PUT does not treat sidecar-only parent as a collection', async () => {
	const operations = { put: [] };
	const bucket = {
		operations,
		async head(key) {
			if (key === '.__webdav__/directories/parent.json') {
				return createObject(key);
			}
			return null;
		},
		async get() {
			return null;
		},
		async put(key) {
			operations.put.push(key);
		},
		async delete() {},
		async list() {
			return { objects: [], truncated: false };
		},
	};
	const request = new Request('http://example.com/parent/file.txt', {
		method: 'PUT',
		body: 'data',
	});

	const response = await handlePut(request, bucket);

	assert.equal(response.status, 409);
	assert.deepEqual(operations.put, []);
});

test('PUT accepts a parent collection created by MKCOL sidecar state', async () => {
	const bucket = createTrackingBucket();

	const mkcolResponse = await handleMkcol(new Request('http://example.com/parent/', { method: 'MKCOL' }), bucket);
	const putResponse = await handlePut(
		new Request('http://example.com/parent/file.txt', {
			method: 'PUT',
			body: 'data',
		}),
		bucket,
	);

	assert.equal(mkcolResponse.status, 201);
	assert.equal(putResponse.status, 201);
	assert.equal(bucket.objects.has('parent/file.txt'), true);
});

test('GET resolves implicit directories from child prefixes', async () => {
	const bucket = createListingBucket([createObject('docs/readme.txt')]);
	const request = new Request('http://example.com/docs/', { method: 'GET' });

	const response = await handleGet(request, bucket);

	assert.equal(response.status, 200);
	const body = await response.text();
	assert.match(body, /readme\.txt/);
});

test('GET root listing includes sidecar-backed empty directories and hides internal keys', async () => {
	const bucket = createListingBucket([createObject('.__webdav__/directories/empty.json')]);
	const request = new Request('http://example.com/', { method: 'GET' });

	const response = await handleGet(request, bucket);

	assert.equal(response.status, 200);
	const body = await response.text();
	assert.match(body, /href="\/empty\/"/);
	assert.equal(body.includes('.__webdav__'), false);
});

test('PROPFIND depth=1 includes implicit directories from child prefixes', async () => {
	const bucket = createListingBucket([createObject('docs/readme.txt')]);
	const request = new Request('http://example.com/', {
		method: 'PROPFIND',
		headers: { Depth: '1' },
	});

	const response = await handlePropfind(request, bucket);

	assert.equal(response.status, 207);
	const body = await response.text();
	assert.match(body, /<href>\/docs\/<\/href>/);
});

test('PROPFIND depth=1 includes sidecar-backed empty directories and hides internal keys', async () => {
	const bucket = createListingBucket([createObject('.__webdav__/directories/empty.json')]);
	const request = new Request('http://example.com/', {
		method: 'PROPFIND',
		headers: { Depth: '1' },
	});

	const response = await handlePropfind(request, bucket);

	assert.equal(response.status, 207);
	const body = await response.text();
	assert.match(body, /<href>\/empty\/<\/href>/);
	assert.equal(body.includes('.__webdav__'), false);
});

test('PROPFIND uses sidecar metadata for dead properties', async () => {
	const payload = JSON.stringify({
		kind: 'directory',
		props: SIDE_CAR_PROPS,
	});
	const bucket = createListingBucket([createObject('.__webdav__/directories/empty.json', { bodyText: payload })]);
	const request = new Request('http://example.com/empty/', {
		method: 'PROPFIND',
		headers: { Depth: '0' },
	});

	const response = await handlePropfind(request, bucket);

	assert.equal(response.status, 207);
	const body = await response.text();
	assert.match(body, /<displayname[^>]*>Legacy<\/displayname>/);
});

test('PROPFIND prefers sidecar props over legacy metadata', async () => {
	const sidecarPayload = JSON.stringify({
		kind: 'directory',
		props: { [DEAD_PROPERTY_KEY]: SIDECAR_DISPLAYNAME_PROPERTY },
	});
	const legacyMetadata = {
		resourcetype: '<collection />',
		[DEAD_PROPERTY_KEY]: JSON.stringify(DISPLAYNAME_PROPERTY),
	};
	const bucket = createListingBucket([
		createObject('docs', { customMetadata: legacyMetadata }),
		createObject('.__webdav__/directories/docs.json', { bodyText: sidecarPayload }),
	]);
	const request = new Request('http://example.com/docs/', {
		method: 'PROPFIND',
		headers: { Depth: '0' },
	});

	const response = await handlePropfind(request, bucket);

	assert.equal(response.status, 207);
	const body = await response.text();
	assert.match(body, /<displayname[^>]*>Sidecar<\/displayname>/);
	assert.equal(body.includes('Legacy'), false);
});

test('PROPFIND ignores legacy metadata when sidecar payload is malformed', async () => {
	const legacyMetadata = {
		resourcetype: '<collection />',
		[DEAD_PROPERTY_KEY]: JSON.stringify(DISPLAYNAME_PROPERTY),
	};
	const bucket = createListingBucket([
		createObject('docs', { customMetadata: legacyMetadata }),
		createObject('.__webdav__/directories/docs.json', { bodyText: '{' }),
	]);
	const request = new Request('http://example.com/docs/', {
		method: 'PROPFIND',
		headers: { Depth: '0' },
	});

	const response = await handlePropfind(request, bucket);

	assert.equal(response.status, 207);
	const body = await response.text();
	assert.equal(body.includes('Legacy'), false);
});

test('PROPFIND falls back to legacy directory metadata when no sidecar exists', async () => {
	const legacyMetadata = {
		resourcetype: '<collection />',
		[DEAD_PROPERTY_KEY]: JSON.stringify(DISPLAYNAME_PROPERTY),
	};
	const bucket = createListingBucket([createObject('legacy', { customMetadata: legacyMetadata })]);
	const request = new Request('http://example.com/legacy/', {
		method: 'PROPFIND',
		headers: { Depth: '0' },
	});

	const response = await handlePropfind(request, bucket);

	assert.equal(response.status, 207);
	const body = await response.text();
	assert.match(body, /<displayname[^>]*>Legacy<\/displayname>/);
});

test('PROPPATCH writes directory props to sidecar and scrubs legacy metadata', async () => {
	const legacyMetadata = {
		resourcetype: '<collection />',
		[DEAD_PROPERTY_KEY]: JSON.stringify(DISPLAYNAME_PROPERTY),
		lock_records: JSON.stringify([LOCK_DETAIL_SAMPLE]),
	};
	const bucket = createTrackingBucket([createObject('docs', { customMetadata: legacyMetadata })]);
	const request = new Request('http://example.com/docs/', {
		method: 'PROPPATCH',
		headers: {
			'Content-Type': 'application/xml',
			'Lock-Token': `<urn:uuid:${LOCK_DETAIL_SAMPLE.token}>`,
		},
		body: '<?xml version="1.0" encoding="utf-8"?>\n<propertyupdate xmlns="DAV:"><set><prop><displayname>Updated</displayname></prop></set></propertyupdate>',
	});

	const response = await handleProppatch(request, bucket);

	assert.equal(response.status, 207);
	const sidecar = bucket.objects.get('.__webdav__/directories/docs.json');
	assert.ok(sidecar);
	assert.deepStrictEqual(parseDirectorySidecar(sidecar.bodyText), {
		kind: 'directory',
		props: { [DEAD_PROPERTY_KEY]: UPDATED_DISPLAYNAME_PROPERTY },
		locks: [LOCK_DETAIL_SAMPLE],
	});
	const updatedObject = bucket.objects.get('docs');
	assert.ok(updatedObject);
	assert.equal(updatedObject.customMetadata[DEAD_PROPERTY_KEY], undefined);
	assert.equal(updatedObject.customMetadata.lock_records, undefined);
	assert.equal(updatedObject.customMetadata.resourcetype, '<collection />');
});

test('PROPPATCH accepts sidecar-only directory without trailing slash', async () => {
	const sidecarPayload = serializeDirectorySidecar({ kind: 'directory' });
	const bucket = createTrackingBucket([
		createObject('.__webdav__/directories/docs.json', { bodyText: sidecarPayload }),
	]);
	const request = new Request('http://example.com/docs', {
		method: 'PROPPATCH',
		headers: { 'Content-Type': 'application/xml' },
		body: '<?xml version="1.0" encoding="utf-8"?>\n<propertyupdate xmlns="DAV:"><set><prop><displayname>Updated</displayname></prop></set></propertyupdate>',
	});

	const response = await handleProppatch(request, bucket);

	assert.equal(response.status, 207);
	const sidecar = bucket.objects.get('.__webdav__/directories/docs.json');
	assert.ok(sidecar);
	assert.deepStrictEqual(parseDirectorySidecar(sidecar.bodyText), {
		kind: 'directory',
		props: { [DEAD_PROPERTY_KEY]: UPDATED_DISPLAYNAME_PROPERTY },
	});
});

test('PROPPATCH lazily creates sidecar for implicit directory', async () => {
	const bucket = createTrackingBucket([createObject('docs/readme.txt', { bodyText: 'hello' })]);
	const request = new Request('http://example.com/docs/', {
		method: 'PROPPATCH',
		headers: { 'Content-Type': 'application/xml' },
		body: '<?xml version="1.0" encoding="utf-8"?>\n<propertyupdate xmlns="DAV:"><set><prop><displayname>Updated</displayname></prop></set></propertyupdate>',
	});

	const response = await handleProppatch(request, bucket);

	assert.equal(response.status, 207);
	const sidecar = bucket.objects.get('.__webdav__/directories/docs.json');
	assert.ok(sidecar);
	assert.deepStrictEqual(parseDirectorySidecar(sidecar.bodyText), {
		kind: 'directory',
		props: { [DEAD_PROPERTY_KEY]: UPDATED_DISPLAYNAME_PROPERTY },
	});
	assert.equal(bucket.objects.has('docs'), false);
});

test('PROPPATCH ignores stale sidecar for file paths', async () => {
	const sidecarPayload = serializeDirectorySidecar({ kind: 'directory', props: SIDE_CAR_PROPS });
	const bucket = createTrackingBucket([
		createObject('file.txt', { bodyText: 'hello' }),
		createObject('.__webdav__/directories/file.txt.json', { bodyText: sidecarPayload }),
	]);
	const request = new Request('http://example.com/file.txt', {
		method: 'PROPPATCH',
		headers: { 'Content-Type': 'application/xml' },
		body: '<?xml version="1.0" encoding="utf-8"?>\n<propertyupdate xmlns="DAV:"><set><prop><displayname>Updated</displayname></prop></set></propertyupdate>',
	});

	const response = await handleProppatch(request, bucket);

	assert.equal(response.status, 207);
	const updatedObject = bucket.objects.get('file.txt');
	assert.ok(updatedObject);
	assert.equal(updatedObject.customMetadata[DEAD_PROPERTY_KEY], JSON.stringify(UPDATED_DISPLAYNAME_PROPERTY));
	const sidecar = bucket.objects.get('.__webdav__/directories/file.txt.json');
	assert.ok(sidecar);
	assert.equal(sidecar.bodyText, sidecarPayload);
	assert.equal(
		bucket.operations.put.some((entry) => entry.key === '.__webdav__/directories/file.txt.json'),
		false,
	);
});

test('PROPPATCH does not fall back to legacy when sidecar payload is malformed', async () => {
	const legacyMetadata = {
		resourcetype: '<collection />',
		[DEAD_PROPERTY_KEY]: JSON.stringify(DISPLAYNAME_PROPERTY),
		[CUSTOM_DEAD_PROPERTY_KEY]: JSON.stringify(CUSTOM_DEAD_PROPERTY),
		lock_records: JSON.stringify([LOCK_DETAIL_SAMPLE]),
	};
	const bucket = createTrackingBucket([
		createObject('docs', { customMetadata: legacyMetadata }),
		createObject('.__webdav__/directories/docs.json', { bodyText: '{' }),
	]);
	const request = new Request('http://example.com/docs/', {
		method: 'PROPPATCH',
		headers: { 'Content-Type': 'application/xml' },
		body: '<?xml version="1.0" encoding="utf-8"?>\n<propertyupdate xmlns="DAV:"><set><prop><displayname>Updated</displayname></prop></set></propertyupdate>',
	});

	const response = await handleProppatch(request, bucket);

	assert.equal(response.status, 207);
	const sidecar = bucket.objects.get('.__webdav__/directories/docs.json');
	assert.ok(sidecar);
	assert.deepStrictEqual(parseDirectorySidecar(sidecar.bodyText), {
		kind: 'directory',
		props: { [DEAD_PROPERTY_KEY]: UPDATED_DISPLAYNAME_PROPERTY },
	});
});

test('LOCK creates sidecar for nested implicit directory', async () => {
	const bucket = createTrackingBucket([createObject('a/b/file.txt', { bodyText: 'hello' })]);
	const request = new Request('http://example.com/a/b/', {
		method: 'LOCK',
		body: '<?xml version="1.0" encoding="utf-8"?><lockinfo xmlns="DAV:"><lockscope><exclusive/></lockscope><locktype><write/></locktype></lockinfo>',
		headers: {
			'Content-Type': 'application/xml',
		},
	});

	const response = await handleLock(request, bucket);

	assert.equal(response.status, 201);
	const sidecar = bucket.objects.get('.__webdav__/directories/a/b.json');
	assert.ok(sidecar);
	const parsed = parseDirectorySidecar(sidecar.bodyText);
	assert.ok(parsed?.locks?.length);
});

test('legacy directory markers remain readable', async () => {
	const bucket = createListingBucket([createObject('legacy', { customMetadata: { resourcetype: '<collection />' } })]);
	const request = new Request('http://example.com/legacy/', { method: 'GET' });

	const response = await handleGet(request, bucket);

	assert.equal(response.status, 200);
});

test('MKCOL creates directory sidecar without legacy marker object', async () => {
	const bucket = createTrackingBucket();
	const request = new Request('http://example.com/docs/', { method: 'MKCOL' });

	const response = await handleMkcol(request, bucket);

	assert.equal(response.status, 201);
	assert.deepEqual(
		bucket.operations.put.map((entry) => entry.key),
		['.__webdav__/directories/docs.json'],
	);
	assert.equal(bucket.objects.has('docs'), false);
	const sidecar = bucket.objects.get('.__webdav__/directories/docs.json');
	assert.ok(sidecar);
	assert.deepStrictEqual(parseDirectorySidecar(sidecar.bodyText), { kind: 'directory' });
});

test('MKCOL rejects implicit ancestor created by nested sidecar', async () => {
	const bucket = createTrackingBucket([createObject('.__webdav__/directories/docs/sub.json')]);
	const request = new Request('http://example.com/docs/', { method: 'MKCOL' });

	const response = await handleMkcol(request, bucket);

	assert.equal(response.status, 405);
});

test('DELETE removes implicit directory descendants', async () => {
	const bucket = createTrackingBucket([createObject('docs/readme.txt', { bodyText: 'hello' })]);
	const request = new Request('http://example.com/docs/', { method: 'DELETE' });

	const response = await handleDelete(request, bucket);

	assert.equal(response.status, 204);
	assert.ok(bucket.operations.delete.includes('docs/readme.txt'));
});

test('DELETE removes directory sidecars and descendants', async () => {
	const sidecarPayload = serializeDirectorySidecar({ kind: 'directory' });
	const bucket = createTrackingBucket([
		createObject('docs/readme.txt', { bodyText: 'hello' }),
		createObject('.__webdav__/directories/docs.json', { bodyText: sidecarPayload }),
		createObject('.__webdav__/directories/docs/sub.json', { bodyText: sidecarPayload }),
	]);
	const request = new Request('http://example.com/docs/', { method: 'DELETE' });

	const response = await handleDelete(request, bucket);

	assert.equal(response.status, 204);
	assert.ok(bucket.operations.delete.includes('docs/readme.txt'));
	assert.ok(bucket.operations.delete.includes('.__webdav__/directories/docs.json'));
	assert.ok(bucket.operations.delete.includes('.__webdav__/directories/docs/sub.json'));
});

test('DELETE blocks when directory sidecar lock is missing token', async () => {
	const sidecarPayload = serializeDirectorySidecar({ kind: 'directory', locks: [LOCK_DETAIL_SAMPLE] });
	const bucket = createTrackingBucket([
		createObject('.__webdav__/directories/docs.json', { bodyText: sidecarPayload }),
	]);
	const request = new Request('http://example.com/docs/', { method: 'DELETE' });

	const response = await handleDelete(request, bucket);

	assert.equal(response.status, 423);
});

test('DELETE ignores legacy lock when descendant sidecar payload is malformed', async () => {
	const legacyMetadata = {
		resourcetype: '<collection />',
		lock_records: JSON.stringify([LOCK_DETAIL_SAMPLE]),
	};
	const bucket = createTrackingBucket([
		createObject('docs/sub', { customMetadata: legacyMetadata }),
		createObject('.__webdav__/directories/docs/sub.json', { bodyText: '{' }),
	]);
	const request = new Request('http://example.com/docs/', { method: 'DELETE' });

	const response = await handleDelete(request, bucket);

	assert.equal(response.status, 204);
});

test('DELETE blocks when descendant sidecar lock is missing token', async () => {
	const sidecarPayload = serializeDirectorySidecar({ kind: 'directory', locks: [LOCK_DETAIL_SAMPLE] });
	const bucket = createTrackingBucket([
		createObject('docs/readme.txt', { bodyText: 'hello' }),
		createObject('.__webdav__/directories/docs/sub.json', { bodyText: sidecarPayload }),
	]);
	const request = new Request('http://example.com/docs/', { method: 'DELETE' });

	const response = await handleDelete(request, bucket);

	assert.equal(response.status, 423);
});

test('COPY rejects overwrite when destination exists implicitly', async () => {
	const bucket = createTrackingBucket([
		createObject('dest/readme.txt', { bodyText: 'existing' }),
		createObject('source/readme.txt', { bodyText: 'new' }),
	]);
	const request = new Request('http://example.com/source/', {
		method: 'COPY',
		headers: {
			Destination: 'http://example.com/dest/',
			Overwrite: 'F',
		},
	});

	const response = await handleCopy(request, bucket);

	assert.equal(response.status, 412);
});

test('COPY blocks when destination sidecar lock is missing token', async () => {
	const sidecarPayload = serializeDirectorySidecar({ kind: 'directory', locks: [LOCK_DETAIL_SAMPLE] });
	const bucket = createTrackingBucket([
		createObject('source/readme.txt', { bodyText: 'new' }),
		createObject('.__webdav__/directories/dest.json', { bodyText: sidecarPayload }),
	]);
	const request = new Request('http://example.com/source/', {
		method: 'COPY',
		headers: {
			Destination: 'http://example.com/dest/',
		},
	});

	const response = await handleCopy(request, bucket);

	assert.equal(response.status, 423);
});

test('COPY blocks when destination has both sidecar and legacy object lock', async () => {
	const sidecarPayload = serializeDirectorySidecar({ kind: 'directory', locks: [LOCK_DETAIL_SAMPLE] });
	const legacyMetadata = {
		resourcetype: '<collection />',
		lock_records: JSON.stringify([{ ...LOCK_DETAIL_SAMPLE, token: 'legacy-token' }]),
	};
	const bucket = createTrackingBucket([
		createObject('source/readme.txt', { bodyText: 'new' }),
		createObject('dest', { customMetadata: legacyMetadata }),
		createObject('.__webdav__/directories/dest.json', { bodyText: sidecarPayload }),
	]);
	const request = new Request('http://example.com/source/', {
		method: 'COPY',
		headers: {
			Destination: 'http://example.com/dest/',
		},
	});

	const response = await handleCopy(request, bucket);

	assert.equal(response.status, 423);
});

test('MOVE deletes implicit destination before transfer and responds 204', async () => {
	const bucket = createTrackingBucket([
		createObject('dest/readme.txt', { bodyText: 'existing' }),
		createObject('source/readme.txt', { bodyText: 'new' }),
	]);
	const request = new Request('http://example.com/source/', {
		method: 'MOVE',
		headers: {
			Destination: 'http://example.com/dest/',
		},
	});

	const response = await handleMove(request, bucket);

	assert.equal(response.status, 204);
	assert.ok(bucket.objects.has('dest/readme.txt'));
	assert.equal(bucket.objects.get('dest/readme.txt').bodyText, 'new');
	assert.ok(bucket.operations.delete.includes('dest/readme.txt'));
});

test('MOVE blocks when source sidecar lock is missing token', async () => {
	const sidecarPayload = serializeDirectorySidecar({ kind: 'directory', locks: [LOCK_DETAIL_SAMPLE] });
	const bucket = createTrackingBucket([
		createObject('source/readme.txt', { bodyText: 'new' }),
		createObject('.__webdav__/directories/source.json', { bodyText: sidecarPayload }),
	]);
	const request = new Request('http://example.com/source/', {
		method: 'MOVE',
		headers: {
			Destination: 'http://example.com/dest/',
		},
	});

	const response = await handleMove(request, bucket);

	assert.equal(response.status, 423);
});

test('UNLOCK removes sidecar-only directory lock', async () => {
	const sidecarPayload = serializeDirectorySidecar({ kind: 'directory', locks: [LOCK_DETAIL_SAMPLE] });
	const bucket = createTrackingBucket([
		createObject('.__webdav__/directories/docs.json', { bodyText: sidecarPayload }),
	]);
	const request = new Request('http://example.com/docs/', {
		method: 'UNLOCK',
		headers: {
			'Lock-Token': `<urn:uuid:${LOCK_DETAIL_SAMPLE.token}>`,
		},
	});

	const response = await handleUnlock(request, bucket);

	assert.equal(response.status, 204);
	const updated = bucket.objects.get('.__webdav__/directories/docs.json');
	assert.ok(updated);
	assert.deepStrictEqual(parseDirectorySidecar(updated.bodyText), { kind: 'directory' });
});

test('UNLOCK removes mixed-state directory locks from object and sidecar', async () => {
	const sidecarPayload = serializeDirectorySidecar({ kind: 'directory', locks: [LOCK_DETAIL_SAMPLE] });
	const legacyMetadata = {
		resourcetype: '<collection />',
		lock_records: JSON.stringify([LOCK_DETAIL_SAMPLE]),
	};
	const bucket = createTrackingBucket([
		createObject('docs', { customMetadata: legacyMetadata }),
		createObject('.__webdav__/directories/docs.json', { bodyText: sidecarPayload }),
	]);
	const request = new Request('http://example.com/docs/', {
		method: 'UNLOCK',
		headers: {
			'Lock-Token': `<urn:uuid:${LOCK_DETAIL_SAMPLE.token}>`,
		},
	});

	const response = await handleUnlock(request, bucket);

	assert.equal(response.status, 204);
	const updatedSidecar = bucket.objects.get('.__webdav__/directories/docs.json');
	assert.ok(updatedSidecar);
	assert.deepStrictEqual(parseDirectorySidecar(updatedSidecar.bodyText), { kind: 'directory' });
	const updatedObject = bucket.objects.get('docs');
	assert.ok(updatedObject);
	assert.equal(updatedObject.customMetadata.lock_records, undefined);
});

test('LOCK refresh works for sidecar-only directory lock', async () => {
	const sidecarPayload = serializeDirectorySidecar({ kind: 'directory', locks: [LOCK_DETAIL_SAMPLE] });
	const bucket = createTrackingBucket([
		createObject('.__webdav__/directories/docs.json', { bodyText: sidecarPayload }),
	]);
	const request = new Request('http://example.com/docs/', {
		method: 'LOCK',
		headers: {
			'Lock-Token': `<urn:uuid:${LOCK_DETAIL_SAMPLE.token}>`,
			Timeout: 'Second-120',
		},
	});

	const response = await handleLock(request, bucket);

	assert.equal(response.status, 200);
	const updated = bucket.objects.get('.__webdav__/directories/docs.json');
	assert.ok(updated);
	const parsed = parseDirectorySidecar(updated.bodyText);
	assert.ok(parsed?.locks?.some((lock) => lock.token === LOCK_DETAIL_SAMPLE.token));
});

test('LOCK refresh migrates legacy directory lock to sidecar', async () => {
	const legacyMetadata = {
		resourcetype: '<collection />',
		lock_records: JSON.stringify([LOCK_DETAIL_SAMPLE]),
	};
	const bucket = createTrackingBucket([createObject('docs', { customMetadata: legacyMetadata })]);
	const request = new Request('http://example.com/docs/', {
		method: 'LOCK',
		headers: {
			'Lock-Token': `<urn:uuid:${LOCK_DETAIL_SAMPLE.token}>`,
			Timeout: 'Second-120',
		},
	});

	const response = await handleLock(request, bucket);

	assert.equal(response.status, 200);
	const updatedSidecar = bucket.objects.get('.__webdav__/directories/docs.json');
	assert.ok(updatedSidecar);
	const parsed = parseDirectorySidecar(updatedSidecar.bodyText);
	const refreshedSidecar = parsed?.locks?.find((lock) => lock.token === LOCK_DETAIL_SAMPLE.token);
	assert.ok(refreshedSidecar);
	assert.equal(refreshedSidecar.timeout, 'Second-120');
	const updatedObject = bucket.objects.get('docs');
	assert.ok(updatedObject);
	assert.equal(updatedObject.customMetadata.lock_records, undefined);
});

test('LOCK refresh updates mixed-state sidecar locks', async () => {
	const sidecarPayload = serializeDirectorySidecar({ kind: 'directory', locks: [LOCK_DETAIL_SAMPLE] });
	const legacyMetadata = {
		resourcetype: '<collection />',
		lock_records: JSON.stringify([LOCK_DETAIL_SAMPLE]),
	};
	const bucket = createTrackingBucket([
		createObject('docs', { customMetadata: legacyMetadata }),
		createObject('.__webdav__/directories/docs.json', { bodyText: sidecarPayload }),
	]);
	const request = new Request('http://example.com/docs/', {
		method: 'LOCK',
		headers: {
			'Lock-Token': `<urn:uuid:${LOCK_DETAIL_SAMPLE.token}>`,
			Timeout: 'Second-120',
		},
	});

	const response = await handleLock(request, bucket);

	assert.equal(response.status, 200);
	const updated = bucket.objects.get('.__webdav__/directories/docs.json');
	assert.ok(updated);
	const parsed = parseDirectorySidecar(updated.bodyText);
	const refreshedSidecar = parsed?.locks?.find((lock) => lock.token === LOCK_DETAIL_SAMPLE.token);
	assert.ok(refreshedSidecar);
	assert.equal(refreshedSidecar.timeout, 'Second-120');
	const updatedObject = bucket.objects.get('docs');
	assert.ok(updatedObject);
	assert.equal(updatedObject.customMetadata.lock_records, undefined);
});

test('LOCK refresh through a child resource returns the ancestor collection lock', async () => {
	const collectionLock = {
		...LOCK_DETAIL_SAMPLE,
		root: '/docs/',
	};
	const sidecarPayload = serializeDirectorySidecar({ kind: 'directory', locks: [collectionLock] });
	const bucket = createTrackingBucket([
		createObject('docs/file.txt', { bodyText: 'hello' }),
		createObject('.__webdav__/directories/docs.json', { bodyText: sidecarPayload }),
	]);
	const request = new Request('http://example.com/docs/file.txt', {
		method: 'LOCK',
		headers: {
			If: `(<urn:uuid:${collectionLock.token}>)`,
			Timeout: 'Second-120',
		},
	});

	const response = await handleLock(request, bucket);

	assert.equal(response.status, 200);
	const body = await response.text();
	assert.match(body, new RegExp(collectionLock.token));
	assert.match(body, /\/docs\//);
	const updated = bucket.objects.get('.__webdav__/directories/docs.json');
	assert.ok(updated);
	const parsed = parseDirectorySidecar(updated.bodyText);
	const refreshedLock = parsed?.locks?.find((lock) => lock.token === collectionLock.token);
	assert.ok(refreshedLock);
	assert.equal(refreshedLock.timeout, 'Second-120');
});

test('LOCK creates sidecar lock on explicit sidecar-only directory', async () => {
	const sidecarPayload = serializeDirectorySidecar({ kind: 'directory' });
	const bucket = createTrackingBucket([
		createObject('.__webdav__/directories/docs.json', { bodyText: sidecarPayload }),
	]);
	const request = new Request('http://example.com/docs/', {
		method: 'LOCK',
		body: '<?xml version="1.0" encoding="utf-8"?><lockinfo xmlns="DAV:"><lockscope><exclusive/></lockscope><locktype><write/></locktype></lockinfo>',
		headers: {
			'Content-Type': 'application/xml',
		},
	});

	const response = await handleLock(request, bucket);

	assert.equal(response.status, 201);
	const updated = bucket.objects.get('.__webdav__/directories/docs.json');
	assert.ok(updated);
	const parsed = parseDirectorySidecar(updated.bodyText);
	assert.ok(parsed?.locks?.length);
});

test('LOCK accepts sidecar-only directory without trailing slash', async () => {
	const sidecarPayload = serializeDirectorySidecar({ kind: 'directory' });
	const bucket = createTrackingBucket([
		createObject('.__webdav__/directories/docs.json', { bodyText: sidecarPayload }),
	]);
	const request = new Request('http://example.com/docs', {
		method: 'LOCK',
		body: '<?xml version="1.0" encoding="utf-8"?><lockinfo xmlns="DAV:"><lockscope><exclusive/></lockscope><locktype><write/></locktype></lockinfo>',
		headers: {
			'Content-Type': 'application/xml',
		},
	});

	const response = await handleLock(request, bucket);

	assert.equal(response.status, 201);
	const updated = bucket.objects.get('.__webdav__/directories/docs.json');
	assert.ok(updated);
	const parsed = parseDirectorySidecar(updated.bodyText);
	assert.ok(parsed?.locks?.length);
});

test('LOCK creates sidecar lock on implicit directory', async () => {
	const bucket = createTrackingBucket([createObject('docs/readme.txt', { bodyText: 'hello' })]);
	const request = new Request('http://example.com/docs/', {
		method: 'LOCK',
		body: '<?xml version="1.0" encoding="utf-8"?><lockinfo xmlns="DAV:"><lockscope><exclusive/></lockscope><locktype><write/></locktype></lockinfo>',
		headers: {
			'Content-Type': 'application/xml',
		},
	});

	const response = await handleLock(request, bucket);

	assert.equal(response.status, 201);
	const updated = bucket.objects.get('.__webdav__/directories/docs.json');
	assert.ok(updated);
	const parsed = parseDirectorySidecar(updated.bodyText);
	assert.ok(parsed?.locks?.length);
	assert.equal(bucket.objects.has('docs'), false);
});

test('LOCK creates a null resource under a sidecar-backed parent collection', async () => {
	const bucket = createTrackingBucket([
		createObject('.__webdav__/directories/docs.json', { bodyText: serializeDirectorySidecar({ kind: 'directory' }) }),
	]);
	const request = new Request('http://example.com/docs/unmapped.txt', {
		method: 'LOCK',
		body: '<?xml version="1.0" encoding="utf-8"?><lockinfo xmlns="DAV:"><lockscope><exclusive/></lockscope><locktype><write/></locktype></lockinfo>',
		headers: {
			'Content-Type': 'application/xml',
			Depth: '0',
		},
	});

	const response = await handleLock(request, bucket);

	assert.equal(response.status, 201);
	assert.equal(bucket.objects.has('docs/unmapped.txt'), true);
});

test('LOCK refresh ignores legacy lock when sidecar has different token', async () => {
	const sidecarPayload = serializeDirectorySidecar({
		kind: 'directory',
		locks: [{ ...LOCK_DETAIL_SAMPLE, token: 'sidecar-token' }],
	});
	const legacyMetadata = {
		resourcetype: '<collection />',
		lock_records: JSON.stringify([LOCK_DETAIL_SAMPLE]),
	};
	const bucket = createTrackingBucket([
		createObject('docs', { customMetadata: legacyMetadata }),
		createObject('.__webdav__/directories/docs.json', { bodyText: sidecarPayload }),
	]);
	const request = new Request('http://example.com/docs/', {
		method: 'LOCK',
		headers: {
			'Lock-Token': `<urn:uuid:${LOCK_DETAIL_SAMPLE.token}>`,
			Timeout: 'Second-120',
		},
	});

	const response = await handleLock(request, bucket);

	assert.equal(response.status, 423);
	const updatedSidecar = bucket.objects.get('.__webdav__/directories/docs.json');
	assert.ok(updatedSidecar);
	const parsed = parseDirectorySidecar(updatedSidecar.bodyText);
	assert.ok(parsed?.locks?.some((lock) => lock.token === 'sidecar-token'));
	assert.equal(
		parsed?.locks?.some((lock) => lock.token === LOCK_DETAIL_SAMPLE.token),
		false,
	);
	const updatedObject = bucket.objects.get('docs');
	assert.ok(updatedObject);
	const objectLocks = JSON.parse(updatedObject.customMetadata.lock_records ?? '[]');
	assert.ok(objectLocks.some((lock) => lock.token === LOCK_DETAIL_SAMPLE.token));
});

test('LOCK ignores stale sidecar for file paths', async () => {
	const sidecarPayload = serializeDirectorySidecar({ kind: 'directory', locks: [LOCK_DETAIL_SAMPLE] });
	const bucket = createTrackingBucket([
		createObject('file.txt', { bodyText: 'hello' }),
		createObject('.__webdav__/directories/file.txt.json', { bodyText: sidecarPayload }),
	]);
	const request = new Request('http://example.com/file.txt', {
		method: 'LOCK',
		body: '<?xml version="1.0" encoding="utf-8"?><lockinfo xmlns="DAV:"><lockscope><exclusive/></lockscope><locktype><write/></locktype></lockinfo>',
		headers: {
			'Content-Type': 'application/xml',
		},
	});

	const response = await handleLock(request, bucket);

	assert.equal(response.status, 201);
	const updatedObject = bucket.objects.get('file.txt');
	assert.ok(updatedObject);
	const objectLocks = JSON.parse(updatedObject.customMetadata.lock_records ?? '[]');
	assert.ok(objectLocks.length > 0);
	const sidecar = bucket.objects.get('.__webdav__/directories/file.txt.json');
	assert.ok(sidecar);
	assert.equal(sidecar.bodyText, sidecarPayload);
	assert.equal(
		bucket.operations.put.some((entry) => entry.key === '.__webdav__/directories/file.txt.json'),
		false,
	);
});

test('UNLOCK ignores legacy lock when sidecar has different token', async () => {
	const sidecarPayload = serializeDirectorySidecar({
		kind: 'directory',
		locks: [{ ...LOCK_DETAIL_SAMPLE, token: 'sidecar-token' }],
	});
	const legacyMetadata = {
		resourcetype: '<collection />',
		lock_records: JSON.stringify([LOCK_DETAIL_SAMPLE]),
	};
	const bucket = createTrackingBucket([
		createObject('docs', { customMetadata: legacyMetadata }),
		createObject('.__webdav__/directories/docs.json', { bodyText: sidecarPayload }),
	]);
	const request = new Request('http://example.com/docs/', {
		method: 'UNLOCK',
		headers: {
			'Lock-Token': `<urn:uuid:${LOCK_DETAIL_SAMPLE.token}>`,
		},
	});

	const response = await handleUnlock(request, bucket);

	assert.equal(response.status, 423);
	const updatedSidecar = bucket.objects.get('.__webdav__/directories/docs.json');
	assert.ok(updatedSidecar);
	const parsed = parseDirectorySidecar(updatedSidecar.bodyText);
	assert.ok(parsed?.locks?.some((lock) => lock.token === 'sidecar-token'));
	const updatedObject = bucket.objects.get('docs');
	assert.ok(updatedObject);
	const objectLocks = JSON.parse(updatedObject.customMetadata.lock_records ?? '[]');
	assert.ok(objectLocks.some((lock) => lock.token === LOCK_DETAIL_SAMPLE.token));
});

test('UNLOCK ignores stale sidecar for file paths', async () => {
	const fileLock = { ...LOCK_DETAIL_SAMPLE, token: 'file-token' };
	const sidecarPayload = serializeDirectorySidecar({ kind: 'directory', locks: [LOCK_DETAIL_SAMPLE] });
	const bucket = createTrackingBucket([
		createObject('file.txt', { bodyText: 'hello', customMetadata: { lock_records: JSON.stringify([fileLock]) } }),
		createObject('.__webdav__/directories/file.txt.json', { bodyText: sidecarPayload }),
	]);
	const request = new Request('http://example.com/file.txt', {
		method: 'UNLOCK',
		headers: {
			'Lock-Token': `<urn:uuid:${fileLock.token}>`,
		},
	});

	const response = await handleUnlock(request, bucket);

	assert.equal(response.status, 204);
	const updatedObject = bucket.objects.get('file.txt');
	assert.ok(updatedObject);
	assert.equal(updatedObject.customMetadata.lock_records, undefined);
	const sidecar = bucket.objects.get('.__webdav__/directories/file.txt.json');
	assert.ok(sidecar);
	assert.equal(sidecar.bodyText, sidecarPayload);
	assert.equal(
		bucket.operations.put.some((entry) => entry.key === '.__webdav__/directories/file.txt.json'),
		false,
	);
});

test('COPY Depth 0 from implicit directory does not report success', async () => {
	const bucket = createTrackingBucket([createObject('source/readme.txt', { bodyText: 'new' })]);
	const request = new Request('http://example.com/source/', {
		method: 'COPY',
		headers: {
			Destination: 'http://example.com/dest/',
			Depth: '0',
		},
	});

	const response = await handleCopy(request, bucket);

	assert.equal(response.status, 404);
	assert.equal(bucket.objects.has('.__webdav__/directories/dest.json'), false);
	assert.equal(bucket.objects.has('dest'), false);
});

test('COPY preserves implicit directories without creating sidecars', async () => {
	const bucket = createTrackingBucket([createObject('docs/readme.txt', { bodyText: 'hello' })]);
	const request = new Request('http://example.com/docs/', {
		method: 'COPY',
		headers: {
			Destination: 'http://example.com/copydocs/',
		},
	});

	const response = await handleCopy(request, bucket);

	assert.equal(response.status, 201);
	assert.ok(bucket.objects.has('copydocs/readme.txt'));
	assert.equal(bucket.objects.has('.__webdav__/directories/copydocs.json'), false);
	assert.equal(bucket.objects.has('copydocs'), false);
});

test('COPY treats sidecar-only destination as existing', async () => {
	const bucket = createTrackingBucket([
		createObject('.__webdav__/directories/dest.json', { bodyText: serializeDirectorySidecar({ kind: 'directory' }) }),
		createObject('source/readme.txt', { bodyText: 'new' }),
	]);
	const request = new Request('http://example.com/source/', {
		method: 'COPY',
		headers: {
			Destination: 'http://example.com/dest/',
		},
	});

	const response = await handleCopy(request, bucket);

	assert.equal(response.status, 204);
	assert.ok(bucket.objects.has('dest/readme.txt'));
});

test('file COPY ignores implicit destination for overwrite checks', async () => {
	const bucket = createTrackingBucket([createObject('dest/readme.txt', { bodyText: 'existing' })]);
	const request = new Request('http://example.com/source.txt', {
		method: 'COPY',
		headers: {
			Destination: 'http://example.com/dest/',
			Overwrite: 'F',
		},
	});
	bucket.objects.set('source.txt', createObject('source.txt', { bodyText: 'new' }));

	const response = await handleCopy(request, bucket);

	assert.equal(response.status, 201);
});

test('file COPY accepts a destination under a sidecar-backed parent collection', async () => {
	const bucket = createTrackingBucket();
	await handleMkcol(new Request('http://example.com/parent/', { method: 'MKCOL' }), bucket);
	await handlePut(
		new Request('http://example.com/parent/source.txt', {
			method: 'PUT',
			body: 'data',
		}),
		bucket,
	);

	const response = await handleCopy(
		new Request('http://example.com/parent/source.txt', {
			method: 'COPY',
			headers: {
				Destination: 'http://example.com/parent/copied.txt',
			},
		}),
		bucket,
	);

	assert.equal(response.status, 201);
	assert.equal(bucket.objects.has('parent/copied.txt'), true);
});

test('file MOVE ignores implicit destination for overwrite checks', async () => {
	const bucket = createTrackingBucket([createObject('dest/readme.txt', { bodyText: 'existing' })]);
	const request = new Request('http://example.com/source.txt', {
		method: 'MOVE',
		headers: {
			Destination: 'http://example.com/dest/',
			Overwrite: 'F',
		},
	});
	bucket.objects.set('source.txt', createObject('source.txt', { bodyText: 'new' }));

	const response = await handleMove(request, bucket);

	assert.equal(response.status, 201);
});

test('file MOVE accepts a destination under a sidecar-backed parent collection', async () => {
	const bucket = createTrackingBucket();
	await handleMkcol(new Request('http://example.com/parent/', { method: 'MKCOL' }), bucket);
	await handlePut(
		new Request('http://example.com/parent/source.txt', {
			method: 'PUT',
			body: 'data',
		}),
		bucket,
	);

	const response = await handleMove(
		new Request('http://example.com/parent/source.txt', {
			method: 'MOVE',
			headers: {
				Destination: 'http://example.com/parent/moved.txt',
			},
		}),
		bucket,
	);

	assert.equal(response.status, 201);
	assert.equal(bucket.objects.has('parent/moved.txt'), true);
	assert.equal(bucket.objects.has('parent/source.txt'), false);
});

test('file MOVE does not delete implicit destination before transfer', async () => {
	const bucket = createTrackingBucket([createObject('dest/readme.txt', { bodyText: 'existing' })]);
	const request = new Request('http://example.com/source.txt', {
		method: 'MOVE',
		headers: {
			Destination: 'http://example.com/dest/',
		},
	});
	bucket.objects.set('source.txt', createObject('source.txt', { bodyText: 'new' }));

	const response = await handleMove(request, bucket);

	assert.equal(response.status, 201);
	assert.ok(bucket.objects.has('dest'));
	assert.equal(bucket.objects.has('dest/readme.txt'), true);
});

test('file COPY ignores sidecar-backed destination for overwrite checks', async () => {
	const bucket = createTrackingBucket([
		createObject('.__webdav__/directories/dest.json', { bodyText: serializeDirectorySidecar({ kind: 'directory' }) }),
	]);
	const request = new Request('http://example.com/source.txt', {
		method: 'COPY',
		headers: {
			Destination: 'http://example.com/dest/',
			Overwrite: 'F',
		},
	});
	bucket.objects.set('source.txt', createObject('source.txt', { bodyText: 'new' }));

	const response = await handleCopy(request, bucket);

	assert.equal(response.status, 201);
});

test('file MOVE ignores sidecar-backed destination for overwrite checks', async () => {
	const bucket = createTrackingBucket([
		createObject('.__webdav__/directories/dest.json', { bodyText: serializeDirectorySidecar({ kind: 'directory' }) }),
	]);
	const request = new Request('http://example.com/source.txt', {
		method: 'MOVE',
		headers: {
			Destination: 'http://example.com/dest/',
			Overwrite: 'F',
		},
	});
	bucket.objects.set('source.txt', createObject('source.txt', { bodyText: 'new' }));

	const response = await handleMove(request, bucket);

	assert.equal(response.status, 201);
});

test('file MOVE does not delete sidecar-backed destination before transfer', async () => {
	const bucket = createTrackingBucket([
		createObject('.__webdav__/directories/dest.json', { bodyText: serializeDirectorySidecar({ kind: 'directory' }) }),
	]);
	const request = new Request('http://example.com/source.txt', {
		method: 'MOVE',
		headers: {
			Destination: 'http://example.com/dest/',
		},
	});
	bucket.objects.set('source.txt', createObject('source.txt', { bodyText: 'new' }));

	const response = await handleMove(request, bucket);

	assert.equal(response.status, 201);
	assert.ok(bucket.objects.has('.__webdav__/directories/dest.json'));
});

test('MOVE preserves implicit directories without creating sidecars', async () => {
	const bucket = createTrackingBucket([createObject('docs/readme.txt', { bodyText: 'hello' })]);
	const request = new Request('http://example.com/docs/', {
		method: 'MOVE',
		headers: {
			Destination: 'http://example.com/moved/',
		},
	});

	const response = await handleMove(request, bucket);

	assert.equal(response.status, 201);
	assert.ok(bucket.objects.has('moved/readme.txt'));
	assert.equal(bucket.objects.has('.__webdav__/directories/moved.json'), false);
	assert.equal(bucket.objects.has('moved'), false);
	assert.ok(bucket.operations.delete.includes('docs/readme.txt'));
});

test('COPY migrates legacy directory markers to sidecars', async () => {
	const legacyMetadata = {
		resourcetype: '<collection />',
		[DEAD_PROPERTY_KEY]: JSON.stringify(DISPLAYNAME_PROPERTY),
	};
	const bucket = createTrackingBucket([
		createObject('docs', { customMetadata: legacyMetadata }),
		createObject('docs/readme.txt', { bodyText: 'hello' }),
	]);
	const request = new Request('http://example.com/docs/', {
		method: 'COPY',
		headers: {
			Destination: 'http://example.com/backup/',
		},
	});

	const response = await handleCopy(request, bucket);

	assert.equal(response.status, 201);
	assert.ok(bucket.objects.has('backup/readme.txt'));
	assert.equal(bucket.objects.has('backup'), false);
	const sidecar = bucket.objects.get('.__webdav__/directories/backup.json');
	assert.ok(sidecar);
	assert.deepStrictEqual(parseDirectorySidecar(sidecar.bodyText), {
		kind: 'directory',
		props: { [DEAD_PROPERTY_KEY]: DISPLAYNAME_PROPERTY },
	});
	assert.ok(bucket.objects.has('docs'));
});

test('MOVE transfers sidecars and cleans legacy markers', async () => {
	const sidecarPayload = serializeDirectorySidecar({
		kind: 'directory',
		props: { [DEAD_PROPERTY_KEY]: DISPLAYNAME_PROPERTY },
	});
	const legacyMetadata = {
		resourcetype: '<collection />',
		[DEAD_PROPERTY_KEY]: JSON.stringify(DISPLAYNAME_PROPERTY),
	};
	const bucket = createTrackingBucket([
		createObject('docs', { customMetadata: legacyMetadata }),
		createObject('docs/readme.txt', { bodyText: 'hello' }),
		createObject('.__webdav__/directories/docs.json', { bodyText: sidecarPayload }),
	]);
	const request = new Request('http://example.com/docs/', {
		method: 'MOVE',
		headers: {
			Destination: 'http://example.com/archive/',
		},
	});

	const response = await handleMove(request, bucket);

	assert.equal(response.status, 201);
	assert.equal(bucket.objects.has('docs'), false);
	assert.equal(bucket.objects.has('.__webdav__/directories/docs.json'), false);
	assert.ok(bucket.operations.delete.includes('docs'));
	assert.ok(bucket.operations.delete.includes('.__webdav__/directories/docs.json'));
	assert.ok(bucket.objects.has('archive/readme.txt'));
	const sidecar = bucket.objects.get('.__webdav__/directories/archive.json');
	assert.ok(sidecar);
	assert.deepStrictEqual(parseDirectorySidecar(sidecar.bodyText), {
		kind: 'directory',
		props: { [DEAD_PROPERTY_KEY]: DISPLAYNAME_PROPERTY },
	});
	assert.equal(bucket.objects.has('archive'), false);
});
