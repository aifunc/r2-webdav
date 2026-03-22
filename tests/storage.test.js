import assert from 'node:assert/strict';
import { test } from 'node:test';

import { transferCollectionDescendants } from '../src/domain/storage.js';

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

function createPlainObject(key) {
	return {
		key,
		size: 1,
		etag: 'etag',
		uploaded: new Date('2024-01-01T00:00:00.000Z'),
		httpMetadata: {},
		customMetadata: {},
	};
}

test('transferCollectionDescendants returns false when any descendant transfer source is missing', async () => {
	const source = createCollectionObject('docs');
	const bucket = {
		async list() {
			return {
				objects: [createPlainObject('docs/file.txt')],
				truncated: false,
			};
		},
		async get(key) {
			if (key === 'docs') {
				return {
					body: new Uint8Array(),
					httpMetadata: {},
				};
			}
			return null;
		},
		async put() {},
		async delete() {},
	};

	const transferred = await transferCollectionDescendants(bucket, source, 'archive', () => ({}));

	assert.equal(transferred, false);
});
