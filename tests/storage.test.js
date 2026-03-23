import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	listCollectionChildren,
	resolveResource,
	transferCollectionDescendants,
	transferDirectoryResources,
} from '../src/domain/storage.js';

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

test('transferDirectoryResources does not write partial targets when a descendant source is missing', async () => {
	const objects = new Map([
		['docs', createCollectionObject('docs')],
		['docs/a.txt', createPlainObject('docs/a.txt')],
		['docs/b.txt', createPlainObject('docs/b.txt')],
	]);
	const operations = { put: [], delete: [] };
	const bucket = {
		objects,
		operations,
		async head(key) {
			return objects.get(key) ?? null;
		},
		async get(key) {
			if (key === 'docs/b.txt') {
				return null;
			}
			const object = objects.get(key);
			if (!object) {
				return null;
			}
			return {
				body: new Uint8Array([1]),
				httpMetadata: object.httpMetadata,
			};
		},
		async put(key) {
			operations.put.push(key);
			objects.set(key, createPlainObject(key));
		},
		async delete(key) {
			operations.delete.push(key);
			objects.delete(key);
		},
		async list(options = {}) {
			const prefix = options.prefix ?? '';
			return {
				objects: [...objects.values()].filter((object) => object.key.startsWith(prefix) && object.key !== 'docs'),
				truncated: false,
			};
		},
	};

	const transferred = await transferDirectoryResources(bucket, 'docs', 'archive', () => ({}));

	assert.equal(transferred, false);
	assert.deepEqual(operations.put, []);
	assert.equal(objects.has('archive/a.txt'), false);
});

test('resolveResource retries transient R2 list errors for implicit collections', async () => {
	let listCalls = 0;
	let loggedErrors = [];
	let originalConsoleError = console.error;
	console.error = (...args) => loggedErrors.push(args);

	try {
		let resolved = await resolveResource(
			{
				async head() {
					return null;
				},
				async get() {
					return null;
				},
				async list() {
					listCalls++;
					if (listCalls === 1) {
						throw new Error('list: Unspecified error (0)');
					}
					return {
						objects: [createPlainObject('docs/file.txt')],
						truncated: false,
					};
				},
			},
			'docs',
		);

		assert.equal(listCalls, 2);
		assert.deepEqual(resolved, { object: null, isCollection: true });
		assert.equal(loggedErrors.length, 1);
	} finally {
		console.error = originalConsoleError;
	}
});

test('listCollectionChildren rethrows non-retryable R2 list errors', async () => {
	let errors = [];
	let originalConsoleError = console.error;
	console.error = (...args) => errors.push(args);

	try {
		await assert.rejects(async () => {
			for await (let _entry of listCollectionChildren(
				{
					async list() {
						throw new Error('list: Access denied');
					},
				},
				'docs',
			)) {
				assert.fail('iterator should not yield entries');
			}
		}, /Access denied/);

		assert.equal(errors.length, 1);
	} finally {
		console.error = originalConsoleError;
	}
});
