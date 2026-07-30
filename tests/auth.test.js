import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getAuthorizedUsers, isAuthorized } from '../src/domain/auth.js';

function createBasicAuthorizationHeader(username, password) {
	let credentials = `${username}:${password}`;
	let base64 = Buffer.from(credentials, 'utf8').toString('base64');
	return `Basic ${base64}`;
}

test('isAuthorized accepts Unicode credentials without throwing', async () => {
	let username = '用户';
	let password = '密碼';
	let authorizationHeader = createBasicAuthorizationHeader(username, password);

	assert.equal(await isAuthorized(authorizationHeader, [{ username, password }]), true);
});

test('isAuthorized rejects mismatched credentials', async () => {
	let authorizationHeader = createBasicAuthorizationHeader('user', 'secret');

	assert.equal(await isAuthorized(authorizationHeader, [{ username: 'user', password: 'other-secret' }]), false);
});

test('isAuthorized accepts any configured user from AUTH_USERS', async () => {
	let authorizationHeader = createBasicAuthorizationHeader('bob', 's3cret');

	assert.equal(
		await isAuthorized(
			authorizationHeader,
			getAuthorizedUsers({
				AUTH_USERS: 'alice:pw-1\nbob:s3cret\ncarol:pw-3',
			}),
		),
		true,
	);
});

test('isAuthorized accepts case-insensitive Basic scheme and extra spacing', async () => {
	assert.equal(
		await isAuthorized(`basic   ${Buffer.from('bob:s3cret', 'utf8').toString('base64')}   `, [
			{ username: 'bob', password: 's3cret' },
		]),
		true,
	);
});

test('isAuthorized rejects mixed username and password from different AUTH_USERS entries', async () => {
	assert.equal(
		await isAuthorized(
			createBasicAuthorizationHeader('alice', 's3cret'),
			getAuthorizedUsers({
				AUTH_USERS: 'alice:pw-1\nbob:s3cret',
			}),
		),
		false,
	);
});

test('getAuthorizedUsers ignores blank and invalid AUTH_USERS lines', () => {
	assert.deepStrictEqual(
		getAuthorizedUsers({
			AUTH_USERS: '\ninvalid\nalice:pw-1\n:no-user\nbob:\n',
		}),
		[
			{ username: 'alice', password: 'pw-1' },
			{ username: 'bob', password: '' },
		],
	);
});

test('getAuthorizedUsers returns empty array when AUTH_USERS is absent or empty', () => {
	assert.deepStrictEqual(getAuthorizedUsers({}), []);
	assert.deepStrictEqual(
		getAuthorizedUsers({
			AUTH_USERS: '',
		}),
		[],
	);
});

test('getAuthorizedUsers prefers AUTH_USERS over USERNAME/PASSWORD fallback', () => {
	let authUsers = getAuthorizedUsers({
		AUTH_USERS: 'alice:pw-1',
		USERNAME: 'bob',
		PASSWORD: 's3cret',
	});
	assert.deepStrictEqual(authUsers, [{ username: 'alice', password: 'pw-1' }]);
});

test('getAuthorizedUsers falls back to USERNAME/PASSWORD when AUTH_USERS is absent', () => {
	let authUsers = getAuthorizedUsers({
		USERNAME: 'bob',
		PASSWORD: 's3cret',
	});
	assert.deepStrictEqual(authUsers, [{ username: 'bob', password: 's3cret' }]);
});

test('getAuthorizedUsers returns empty array when only USERNAME or only PASSWORD is set', () => {
	assert.deepStrictEqual(getAuthorizedUsers({ USERNAME: 'bob' }), []);
	assert.deepStrictEqual(getAuthorizedUsers({ PASSWORD: 's3cret' }), []);
});
