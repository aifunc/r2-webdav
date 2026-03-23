import assert from 'node:assert/strict';
import { test } from 'node:test';

import { handleCopy, handleMove } from '../src/webdav/index.js';

const TRANSFER_METHOD_CASES = [
	{
		name: 'COPY',
		handler: handleCopy,
	},
	{
		name: 'MOVE',
		handler: handleMove,
	},
];

function createCollectionObject(key) {
	return {
		key,
		size: 0,
		etag: 'etag',
		uploaded: new Date('2024-01-01T00:00:00.000Z'),
		httpMetadata: {},
		customMetadata: { resourcetype: '<collection />' },
	};
}

function createAncestorConflictBucket() {
	const operations = {
		put: [],
		delete: [],
	};

	return {
		operations,
		async head(key) {
			if (key === 'parent' || key === 'parent/child') {
				return createCollectionObject(key);
			}
			return null;
		},
		async get(key) {
			if (key === 'parent/child') {
				return {
					body: new Uint8Array(),
					httpMetadata: {},
				};
			}
			return null;
		},
		async put(key) {
			operations.put.push(key);
		},
		async delete(key) {
			operations.delete.push(key);
		},
		async list(options) {
			if (options.prefix === 'parent/child/') {
				return {
					objects: [],
					truncated: false,
				};
			}
			return {
				objects: [],
				truncated: false,
			};
		},
	};
}

for (const { name, handler } of TRANSFER_METHOD_CASES) {
	test(`${name} rejects moving a collection to its ancestor path`, async () => {
		const bucket = createAncestorConflictBucket();
		const request = new Request('http://example.com/parent/child/', {
			method: name,
			headers: {
				Destination: 'http://example.com/parent/',
			},
		});

		const response = await handler(request, bucket);

		assert.equal(response.status, 400);
		assert.deepEqual(bucket.operations.put, []);
		assert.deepEqual(bucket.operations.delete, []);
	});
}
