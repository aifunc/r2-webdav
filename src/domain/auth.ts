const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

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

export function isAuthorized(authorizationHeader: string, username: string, password: string): boolean {
	let encoder = new TextEncoder();
	let header = encoder.encode(authorizationHeader);
	let expected = encoder.encode(`Basic ${encodeBase64(encoder.encode(`${username}:${password}`))}`);
	return timingSafeEqual(header, expected);
}
