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

function decodeBasicCredentials(authorizationHeader: string): string | null {
	let match = authorizationHeader.match(/^Basic[ \t]+([A-Za-z0-9+/]+=*)[ \t]*$/i);
	if (match === null) {
		return null;
	}
	let normalized = match[1] + '='.repeat((4 - (match[1].length % 4)) % 4);
	try {
		return new TextDecoder().decode(Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0)));
	} catch {
		return null;
	}
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

let usersCache = new WeakMap<object, BasicCredentials[]>();

export function getAuthorizedUsers(env: {
	AUTH_USERS?: string;
	USERNAME?: string;
	PASSWORD?: string;
}): BasicCredentials[] {
	let cached = usersCache.get(env);
	if (cached !== undefined) {
		return cached;
	}

	let authorizedUsers = parseAuthorizedUsers(env.AUTH_USERS);
	if (authorizedUsers.length === 0 && typeof env.USERNAME === 'string' && typeof env.PASSWORD === 'string') {
		authorizedUsers = [{ username: env.USERNAME, password: env.PASSWORD }];
	}

	usersCache.set(env, authorizedUsers);
	return authorizedUsers;
}

async function sha256Digest(bytes: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

export async function isAuthorized(authorizationHeader: string, authorizedUsers: BasicCredentials[]): Promise<boolean> {
	let credentials = decodeBasicCredentials(authorizationHeader);
	if (credentials === null) {
		return false;
	}

	let encoder = new TextEncoder();
	let hashedCredentials = await sha256Digest(encoder.encode(credentials));
	let matched = false;
	for (const entry of authorizedUsers) {
		if (timingSafeEqual(hashedCredentials, await sha256Digest(encoder.encode(`${entry.username}:${entry.password}`)))) {
			matched = true;
		}
	}
	return matched;
}
