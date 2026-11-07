import assert from 'node:assert/strict';
import test from 'node:test';

import { MutationGuardDurableObject } from '../src/domain/mutation-guard.js';

function createState() {
	let values = new Map();
	return {
		storage: {
			async get(key) {
				return values.get(key);
			},
			async put(key, value) {
				values.set(key, value);
			},
		},
		async blockConcurrencyWhile(callback) {
			return callback();
		},
	};
}

function guardRequest(path, body) {
	return new Request(`https://mutation-guard${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

function createGuard() {
	return new MutationGuardDurableObject(createState(), {});
}

test('durable object guard serializes root against descendants', async () => {
	let guard = createGuard();
	let acquired = await guard.fetch(guardRequest('/acquire', { requests: [{ path: '', mode: 'exclusive' }] }));
	assert.equal(acquired.status, 200);
	let { token } = await acquired.json();

	let blocked = await guard.fetch(guardRequest('/acquire', { requests: [{ path: 'docs', mode: 'shared' }] }));
	assert.equal(blocked.status, 409);

	let released = await guard.fetch(guardRequest('/release', { token }));
	assert.equal(released.status, 204);

	let allowed = await guard.fetch(guardRequest('/acquire', { requests: [{ path: 'docs', mode: 'shared' }] }));
	assert.equal(allowed.status, 200);
});

test('durable object guard shares unrelated sibling paths', async () => {
	let guard = createGuard();
	let first = await guard.fetch(
		guardRequest('/acquire', {
			requests: [
				{ path: '', mode: 'shared' },
				{ path: 'docs/a.txt', mode: 'exclusive' },
			],
		}),
	);
	assert.equal(first.status, 200);

	let sibling = await guard.fetch(
		guardRequest('/acquire', {
			requests: [
				{ path: '', mode: 'shared' },
				{ path: 'docs/b.txt', mode: 'exclusive' },
			],
		}),
	);
	assert.equal(sibling.status, 200);

	let parent = await guard.fetch(guardRequest('/acquire', { requests: [{ path: 'docs', mode: 'exclusive' }] }));
	assert.equal(parent.status, 409);
});

test('durable object guard rejects malformed acquire requests', async () => {
	let guard = createGuard();
	let response = await guard.fetch(guardRequest('/acquire', { requests: [] }));
	assert.equal(response.status, 400);
});
