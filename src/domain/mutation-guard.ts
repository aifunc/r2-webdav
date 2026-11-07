import type { Env } from '../shared/types';

const GUARD_STORAGE_KEY = 'guards';
const MAX_GUARD_REQUESTS = 32;
const MAX_GUARD_PATH_LENGTH = 1024;

type GuardMode = 'shared' | 'exclusive';

interface GuardEntry {
	token: string;
	path: string;
	mode: GuardMode;
	expiresAt: number;
}

interface GuardRequest {
	path: string;
	mode: GuardMode;
}

function isAncestorPath(ancestor: string, descendant: string): boolean {
	return ancestor !== descendant && (ancestor === '' || descendant.startsWith(`${ancestor}/`));
}

function parseGuardRequests(value: unknown): GuardRequest[] | null {
	if (typeof value !== 'object' || value === null) {
		return null;
	}
	let requests = (value as { requests?: unknown }).requests;
	if (!Array.isArray(requests) || requests.length === 0 || requests.length > MAX_GUARD_REQUESTS) {
		return null;
	}
	let parsed: GuardRequest[] = [];
	for (let request of requests) {
		if (typeof request !== 'object' || request === null) {
			return null;
		}
		let { path, mode } = request as { path?: unknown; mode?: unknown };
		if (
			typeof path !== 'string' ||
			path.length > MAX_GUARD_PATH_LENGTH ||
			(mode !== 'shared' && mode !== 'exclusive')
		) {
			return null;
		}
		parsed.push({ path, mode });
	}
	return parsed;
}

function hasConflict(active: GuardEntry[], requests: GuardRequest[]): boolean {
	for (let request of requests) {
		for (let existing of active) {
			if (existing.path === request.path) {
				if (existing.mode === 'exclusive' || request.mode === 'exclusive') {
					return true;
				}
				continue;
			}
			if (isAncestorPath(existing.path, request.path) && existing.mode === 'exclusive') {
				return true;
			}
			if (isAncestorPath(request.path, existing.path) && request.mode === 'exclusive') {
				return true;
			}
		}
	}
	return false;
}

export class MutationGuardDurableObject {
	constructor(
		private readonly state: DurableObjectState,
		_env: Env,
	) {}

	async fetch(request: Request): Promise<Response> {
		let url = new URL(request.url);
		if (request.method === 'POST' && url.pathname === '/acquire') {
			return this.acquire(request);
		}
		if (request.method === 'POST' && url.pathname === '/release') {
			return this.release(request);
		}
		return new Response('Not Found', { status: 404 });
	}

	private async acquire(request: Request): Promise<Response> {
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return new Response('Bad Request', { status: 400 });
		}
		let requests = parseGuardRequests(body);
		if (requests === null) {
			return new Response('Bad Request', { status: 400 });
		}

		let result: { token: string } | null = null;
		await this.state.blockConcurrencyWhile(async () => {
			let now = Date.now();
			let active = ((await this.state.storage.get<GuardEntry[]>(GUARD_STORAGE_KEY)) ?? []).filter(
				(entry) => entry.expiresAt > now,
			);
			if (hasConflict(active, requests)) {
				result = null;
				return;
			}

			let token = crypto.randomUUID();
			let expiresAt = now + 120_000;
			let entries = requests.map((request) => ({ token, path: request.path, mode: request.mode, expiresAt }));
			await this.state.storage.put(GUARD_STORAGE_KEY, [...active, ...entries]);
			result = { token };
		});

		return result === null
			? new Response('Locked', { status: 409 })
			: Response.json({ token: (result as { token: string }).token });
	}

	private async release(request: Request): Promise<Response> {
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return new Response('Bad Request', { status: 400 });
		}
		let token = typeof body === 'object' && body !== null ? (body as { token?: unknown }).token : undefined;
		if (typeof token !== 'string' || token === '') {
			return new Response('Bad Request', { status: 400 });
		}

		await this.state.blockConcurrencyWhile(async () => {
			let guards = (await this.state.storage.get<GuardEntry[]>(GUARD_STORAGE_KEY)) ?? [];
			await this.state.storage.put(
				GUARD_STORAGE_KEY,
				guards.filter((entry) => entry.token !== token),
			);
		});
		return new Response(null, { status: 204 });
	}
}
