const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

type BasicCredentials = {
	username: string;
	password: string;
};

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) {
		return false;
	}
	let mismatch = 0;
	for (let index = 0; index < left.byteLength; index++) {
		mismatch |= left[index] ^ right[index];
	}
	return mismatch === 0;
}

function encodeBase64(bytes: Uint8Array): string {
	let encoded = '';

	for (let index = 0; index < bytes.length; index += 3) {
		let first = bytes[index];
		let second = bytes[index + 1];
		let third = bytes[index + 2];
		let chunk = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);

		encoded += BASE64_ALPHABET[(chunk >> 18) & 63];
		encoded += BASE64_ALPHABET[(chunk >> 12) & 63];
		encoded += second === undefined ? '=' : BASE64_ALPHABET[(chunk >> 6) & 63];
		encoded += third === undefined ? '=' : BASE64_ALPHABET[chunk & 63];
	}

	return encoded;
}

function encodeBasicAuthorization(username: string, password: string): Uint8Array {
	let encoder = new TextEncoder();
	return encoder.encode(`Basic ${encodeBase64(encoder.encode(`${username}:${password}`))}`);
}

function parseAuthorizedUsers(authUsers: string | undefined): BasicCredentials[] {
	return String(authUsers ?? '')
		.split(/\r?\n/)
		.flatMap((line) => {
			let separatorIndex = line.indexOf(':');
			if (separatorIndex <= 0) {
				return [];
			}

			return [
				{
					username: line.slice(0, separatorIndex).trim(),
					password: line.slice(separatorIndex + 1),
				},
			];
		})
		.filter((entry) => entry.username !== '');
}

export function getAuthorizedUsers(env: {
	AUTH_USERS?: string;
	USERNAME?: string;
	PASSWORD?: string;
}): BasicCredentials[] {
	let authorizedUsers = parseAuthorizedUsers(env.AUTH_USERS);
	if (authorizedUsers.length > 0) {
		return authorizedUsers;
	}
	if (typeof env.USERNAME !== 'string' || typeof env.PASSWORD !== 'string') {
		return [];
	}
	return [{ username: env.USERNAME, password: env.PASSWORD }];
}

export function isAuthorized(authorizationHeader: string, authorizedUsers: BasicCredentials[]): boolean {
	let header = new TextEncoder().encode(authorizationHeader);
	return authorizedUsers.some((entry) =>
		timingSafeEqual(header, encodeBasicAuthorization(entry.username, entry.password)),
	);
}
