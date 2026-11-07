import type { Env } from '../shared/types';

const GUARD_KEY_PREFIX = 'guard:';
const MAX_GUARD_REQUESTS = 1024;
const MAX_GUARD_PATH_LENGTH = 1024;
const MAX_GUARD_PATH_CHARS = 32 * 1024;
const MAX_ACTIVE_TOKENS = 256;
const MAX_ACTIVE_ENTRIES = 4096;
const GUARD_LEASE_MS = 120_000;
const GUARD_ALARM_DELAY_MS = 60_000;

type GuardMode = 'shared' | 'exclusive';

interface GuardRequest {
	path: string;
	mode: GuardMode;
}

interface GuardRecord {
	token: string;
	expiresAt: number;
	requests: GuardRequest[];
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
	let totalPathChars = 0;
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
		totalPathChars += path.length;
		parsed.push({ path, mode });
	}
	return totalPathChars <= MAX_GUARD_PATH_CHARS ? parsed : null;
}

function isGuardRecord(value: unknown): value is GuardRecord {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	let record = value as Partial<GuardRecord>;
	return (
		typeof record.token === 'string' &&
		typeof record.expiresAt === 'number' &&
		Array.isArray(record.requests) &&
		record.requests.every(
			(request) =>
				typeof request === 'object' &&
				request !== null &&
				typeof (request as GuardRequest).path === 'string' &&
				((request as GuardRequest).mode === 'shared' || (request as GuardRequest).mode === 'exclusive'),
		)
	);
}

function hasConflict(active: GuardRequest[], requests: GuardRequest[]): boolean {
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

function flattenGuardRequests(records: GuardRecord[]): GuardRequest[] {
	return records.flatMap((record) => record.requests);
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
		if (request.method === 'POST' && url.pathname === '/renew') {
			return this.renew(request);
		}
		if (request.method === 'POST' && url.pathname === '/release') {
			return this.release(request);
		}
		return new Response('Not Found', { status: 404 });
	}

	async alarm(): Promise<void> {
		await this.state.blockConcurrencyWhile(async () => {
			let records = await this.listRecords(Date.now());
			if (records.length > 0) {
				await this.state.storage.setAlarm(Date.now() + GUARD_ALARM_DELAY_MS);
			}
		});
	}

	private async listRecords(now: number): Promise<GuardRecord[]> {
		let listed = await this.state.storage.list<unknown>({ prefix: GUARD_KEY_PREFIX });
		let records: GuardRecord[] = [];
		for (let [key, value] of listed) {
			if (!isGuardRecord(value) || value.expiresAt <= now) {
				await this.state.storage.delete(key);
				continue;
			}
			records.push(value);
		}
		return records;
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

		let result: { token: string } | 'locked' | 'capacity' | null = null;
		await this.state.blockConcurrencyWhile(async () => {
			let now = Date.now();
			let records = await this.listRecords(now);
			let active = flattenGuardRequests(records);
			if (hasConflict(active, requests)) {
				result = 'locked';
				return;
			}
			if (records.length + 1 > MAX_ACTIVE_TOKENS || active.length + requests.length > MAX_ACTIVE_ENTRIES) {
				result = 'capacity';
				return;
			}

			let token = crypto.randomUUID();
			let record: GuardRecord = { token, expiresAt: now + GUARD_LEASE_MS, requests };
			await this.state.storage.put(`${GUARD_KEY_PREFIX}${token}`, record);
			await this.state.storage.setAlarm(now + GUARD_ALARM_DELAY_MS);
			result = { token };
		});

		if (result === 'locked') {
			return new Response('Locked', { status: 409 });
		}
		if (result === 'capacity') {
			return new Response('Guard capacity exceeded', { status: 503 });
		}
		let token = (result as { token?: unknown } | null)?.token;
		if (typeof token !== 'string') {
			return new Response('Locked', { status: 409 });
		}
		return Response.json({ token });
	}

	private async renew(request: Request): Promise<Response> {
		let token = await this.readToken(request);
		if (token === null) {
			return new Response('Bad Request', { status: 400 });
		}

		let renewed = false;
		await this.state.blockConcurrencyWhile(async () => {
			let record = await this.state.storage.get<unknown>(`${GUARD_KEY_PREFIX}${token}`);
			if (!isGuardRecord(record) || record.expiresAt <= Date.now()) {
				return;
			}
			record.expiresAt = Date.now() + GUARD_LEASE_MS;
			await this.state.storage.put(`${GUARD_KEY_PREFIX}${token}`, record);
			renewed = true;
		});

		return renewed ? new Response(null, { status: 204 }) : new Response('Not Found', { status: 404 });
	}

	private async release(request: Request): Promise<Response> {
		let token = await this.readToken(request);
		if (token === null) {
			return new Response('Bad Request', { status: 400 });
		}

		await this.state.blockConcurrencyWhile(async () => {
			await this.state.storage.delete(`${GUARD_KEY_PREFIX}${token}`);
		});
		return new Response(null, { status: 204 });
	}

	private async readToken(request: Request): Promise<string | null> {
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return null;
		}
		let token = typeof body === 'object' && body !== null ? (body as { token?: unknown }).token : undefined;
		return typeof token === 'string' && token !== '' ? token : null;
	}
}
