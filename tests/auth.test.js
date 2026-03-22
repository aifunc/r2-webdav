import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isAuthorized } from '../src/domain/auth.js';

function createBasicAuthorizationHeader(username, password) {
	let credentials = `${username}:${password}`;
	let base64 = Buffer.from(credentials, 'utf8').toString('base64');
	return `Basic ${base64}`;
}

test('isAuthorized accepts Unicode credentials without throwing', () => {
	let username = '用户';
	let password = '密碼';
	let authorizationHeader = createBasicAuthorizationHeader(username, password);

	assert.equal(isAuthorized(authorizationHeader, username, password), true);
});

test('isAuthorized rejects mismatched credentials', () => {
	let authorizationHeader = createBasicAuthorizationHeader('user', 'secret');

	assert.equal(isAuthorized(authorizationHeader, 'user', 'other-secret'), false);
});
