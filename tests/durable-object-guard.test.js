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
			async delete(key) {
				return values.delete(key);
			},
			async list(options = {}) {
				let prefix = options.prefix ?? '';
				let listed = new Map();
				for (let [key, value] of values) {
					if (key.startsWith(prefix)) {
						listed.set(key, value);
					}
				}
				return listed;
			},
			async setAlarm() {},
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

test('durable object guard renews a live token and rejects it after release', async () => {
	let guard = createGuard();
	let acquired = await guard.fetch(guardRequest('/acquire', { requests: [{ path: 'file.txt', mode: 'exclusive' }] }));
	assert.equal(acquired.status, 200);
	let { token } = await acquired.json();

	let renewed = await guard.fetch(guardRequest('/renew', { token }));
	assert.equal(renewed.status, 204);

	let released = await guard.fetch(guardRequest('/release', { token }));
	assert.equal(released.status, 204);

	let expired = await guard.fetch(guardRequest('/renew', { token }));
	assert.equal(expired.status, 404);
});

test('durable object guard rejects a request whose paths exceed the size budget', async () => {
	let guard = createGuard();
	let requests = Array.from({ length: 70 }, (_, index) => ({
		path: `${index}-${'a'.repeat(500)}`,
		mode: 'shared',
	}));
	let response = await guard.fetch(guardRequest('/acquire', { requests }));
	assert.equal(response.status, 400);
});

test('durable object guard rejects new tokens after the active-token cap', async () => {
	let guard = createGuard();
	for (let index = 0; index < 256; index += 1) {
		let response = await guard.fetch(
			guardRequest('/acquire', { requests: [{ path: `file-${index}.txt`, mode: 'exclusive' }] }),
		);
		assert.equal(response.status, 200);
	}

	let overflow = await guard.fetch(
		guardRequest('/acquire', { requests: [{ path: 'file-overflow.txt', mode: 'exclusive' }] }),
	);
	assert.equal(overflow.status, 503);
});
