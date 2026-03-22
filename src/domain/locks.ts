import {
	DEFAULT_LOCK_TIMEOUT,
	LOCK_METADATA_KEYS,
	LOCK_RECORDS_METADATA_KEY,
	MAX_LOCK_TIMEOUT,
	VALID_LOCK_DEPTHS,
} from '../shared/constants';
import { escapeXml } from '../shared/escape';
import { getAncestorPaths, getCollectionPrefix } from './path';
import { listAll } from './storage';
import type { LockDetails } from '../shared/types';

const SUPPORTED_LOCK_SCOPES: LockDetails['scope'][] = ['exclusive', 'shared'];
const LOCK_FAILURE_RESPONSES = {
	locked: { body: 'Locked', status: 423 },
	preconditionFailed: { body: 'Precondition Failed', status: 412 },
} as const;
const LEGACY_LOCK_METADATA_KEYS = {
	token: 'lock_token',
	owner: 'lock_owner',
	scope: 'lock_scope',
	depth: 'lock_depth',
	timeout: 'lock_timeout',
	expiresAt: 'lock_expires_at',
	root: 'lock_root',
} as const;
const TIMEOUT_PARSERS = [
	(value: string, now: number): { timeout: string; expiresAt: number } | null =>
		value.toLowerCase() === 'infinite'
			? {
					timeout: 'Infinite',
					expiresAt: now + MAX_LOCK_TIMEOUT * 1000,
				}
			: null,
	(value: string, now: number): { timeout: string; expiresAt: number } | null => {
		let seconds = Number(value.match(/^Second-(\d+)$/i)?.[1] ?? NaN);
		if (!Number.isFinite(seconds) || seconds <= 0) {
			return null;
		}

		seconds = Math.min(seconds, MAX_LOCK_TIMEOUT);
		return {
			timeout: `Second-${seconds}`,
			expiresAt: now + seconds * 1000,
		};
	},
];

export function getSupportedLock(): string {
	return SUPPORTED_LOCK_SCOPES.map(
		(scope) => `<lockentry><lockscope><${scope} /></lockscope><locktype><write /></locktype></lockentry>`,
	).join('');
}

export function determineLockDepth(
	resourceType: string | undefined,
	depthHeader: (typeof VALID_LOCK_DEPTHS)[number] | null,
): LockDetails['depth'] {
	if (resourceType === '<collection />') {
		return depthHeader ?? 'infinity';
	}
	return depthHeader === 'infinity' ? 'infinity' : '0';
}

export function normalizeLockToken(lockToken: string): string {
	return lockToken
		.trim()
		.replace(/^<|>$/g, '')
		.replace(/^(?:urn:uuid:|opaquelocktoken:)/, '');
}

function getDefaultTimeout(): { timeout: string; expiresAt: number } {
	return {
		timeout: `Second-${DEFAULT_LOCK_TIMEOUT}`,
		expiresAt: Date.now() + DEFAULT_LOCK_TIMEOUT * 1000,
	};
}

function createLockFailureResponse(type: keyof typeof LOCK_FAILURE_RESPONSES): Response {
	let response = LOCK_FAILURE_RESPONSES[type];
	return new Response(response.body, { status: response.status });
}

function normalizeLockScope(scope: LockDetails['scope'] | undefined): LockDetails['scope'] {
	return scope === 'shared' ? 'shared' : 'exclusive';
}

function normalizeLockDepth(depth: LockDetails['depth'] | undefined): LockDetails['depth'] {
	return depth === 'infinity' ? 'infinity' : '0';
}

function normalizeStoredLockDetails(lockDetails: Partial<LockDetails> & Pick<LockDetails, 'token'>): LockDetails[] {
	let normalized = normalizeLockDetails(lockDetails);
	return normalized === null ? [] : [normalized];
}

function normalizeLockDetails(lockDetails: Partial<LockDetails> & Pick<LockDetails, 'token'>): LockDetails | null {
	let defaultTimeout = getDefaultTimeout();
	let expiresAt = Number(lockDetails.expiresAt ?? 0);
	if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
		expiresAt = defaultTimeout.expiresAt;
	}
	if (expiresAt <= Date.now()) {
		return null;
	}

	return {
		token: lockDetails.token,
		owner: lockDetails.owner,
		scope: normalizeLockScope(lockDetails.scope),
		depth: normalizeLockDepth(lockDetails.depth),
		timeout: lockDetails.timeout ?? defaultTimeout.timeout,
		expiresAt,
		root: lockDetails.root ?? '/',
	};
}

function getScopedLockDetails(
	resourcePath: string,
	candidate: string,
	customMetadata: Record<string, string> | undefined,
	options: { ignoreSharedLocksOnTarget?: boolean } = {},
): LockDetails[] {
	return getLockDetails(customMetadata).filter(
		(lockDetail) =>
			(candidate === resourcePath || lockDetail.depth === 'infinity') &&
			!(options.ignoreSharedLocksOnTarget && candidate === resourcePath && lockDetail.scope === 'shared'),
	);
}

export function getLockDetails(customMetadata: Record<string, string> | undefined): LockDetails[] {
	let records = customMetadata?.[LOCK_RECORDS_METADATA_KEY];
	if (records !== undefined) {
		try {
			let parsed = JSON.parse(records);
			if (Array.isArray(parsed)) {
				return parsed.flatMap((lockDetails) => {
					if (lockDetails && typeof lockDetails === 'object' && typeof lockDetails.token === 'string') {
						return normalizeStoredLockDetails(lockDetails as Partial<LockDetails> & Pick<LockDetails, 'token'>);
					}
					return [];
				});
			}
		} catch {}
	}

	let token = customMetadata?.[LEGACY_LOCK_METADATA_KEYS.token];
	if (token === undefined) {
		return [];
	}

	return normalizeStoredLockDetails({
		token,
		owner: customMetadata?.[LEGACY_LOCK_METADATA_KEYS.owner],
		scope: customMetadata?.[LEGACY_LOCK_METADATA_KEYS.scope] as LockDetails['scope'] | undefined,
		depth: customMetadata?.[LEGACY_LOCK_METADATA_KEYS.depth] as LockDetails['depth'] | undefined,
		timeout: customMetadata?.[LEGACY_LOCK_METADATA_KEYS.timeout] ?? `Second-${DEFAULT_LOCK_TIMEOUT}`,
		expiresAt: Number(customMetadata?.[LEGACY_LOCK_METADATA_KEYS.expiresAt] ?? 0),
		root: customMetadata?.[LEGACY_LOCK_METADATA_KEYS.root] ?? '/',
	});
}

function renderActiveLock(lockDetail: LockDetails): string {
	return `<activelock><locktype><write /></locktype><lockscope><${lockDetail.scope} /></lockscope><depth>${lockDetail.depth}</depth>${lockDetail.owner ? `<owner>${escapeXml(lockDetail.owner)}</owner>` : ''}<timeout>${escapeXml(lockDetail.timeout)}</timeout><locktoken><href>urn:uuid:${escapeXml(lockDetail.token)}</href></locktoken><lockroot><href>${escapeXml(lockDetail.root)}</href></lockroot></activelock>`;
}

export function getLockDiscovery(lockDetails: LockDetails | LockDetails[]): string {
	let lockDetailList = Array.isArray(lockDetails) ? lockDetails : [lockDetails];
	return lockDetailList.map(renderActiveLock).join('');
}

function hasMatchingLockToken(lockDetails: LockDetails[], requestLockTokens: string[]): boolean {
	return lockDetails.some((lockDetail) => requestLockTokens.includes(lockDetail.token));
}

export function hasLockScopeConflict(lockDetails: LockDetails[], requestedScope: LockDetails['scope']): boolean {
	if (requestedScope === 'exclusive') {
		return lockDetails.length > 0;
	}
	return lockDetails.some((lockDetail) => lockDetail.scope === 'exclusive');
}

export function upsertLockDetails(
	currentLocks: LockDetails[],
	lockDetails: LockDetails,
	existingLock: LockDetails | undefined,
): LockDetails[] {
	if (existingLock === undefined) {
		return [...currentLocks, lockDetails];
	}
	return currentLocks.map((currentLock) => (currentLock.token === existingLock.token ? lockDetails : currentLock));
}

export function stripLockMetadata(customMetadata: Record<string, string> | undefined): Record<string, string> {
	let metadata = customMetadata ? { ...customMetadata } : {};
	for (const key of LOCK_METADATA_KEYS) {
		delete metadata[key];
	}
	return metadata;
}

export function withLockMetadata(
	customMetadata: Record<string, string> | undefined,
	lockDetails: LockDetails | LockDetails[],
): Record<string, string> {
	let lockDetailList = Array.isArray(lockDetails) ? lockDetails : [lockDetails];
	if (lockDetailList.length === 0) {
		return stripLockMetadata(customMetadata);
	}
	return {
		...stripLockMetadata(customMetadata),
		[LOCK_RECORDS_METADATA_KEY]: JSON.stringify(lockDetailList),
	};
}

export function getPreservedCustomMetadata(customMetadata: Record<string, string> | undefined): Record<string, string> {
	let lockDetails = getLockDetails(customMetadata);
	if (lockDetails.length === 0) {
		return stripLockMetadata(customMetadata);
	}
	return withLockMetadata(customMetadata, lockDetails);
}

export function parseTimeout(timeoutHeader: string | null): { timeout: string; expiresAt: number } {
	if (timeoutHeader === null) {
		return getDefaultTimeout();
	}

	let now = Date.now();
	for (const item of timeoutHeader.split(',').map((value) => value.trim())) {
		for (const parseTimeoutValue of TIMEOUT_PARSERS) {
			let parsedTimeout = parseTimeoutValue(item, now);
			if (parsedTimeout !== null) {
				return parsedTimeout;
			}
		}
	}

	return getDefaultTimeout();
}

export function getRequestLockTokens(request: Request): string[] {
	let lockTokens: string[] = [];
	let directLockToken = request.headers.get('Lock-Token');
	if (directLockToken) {
		lockTokens.push(normalizeLockToken(directLockToken));
	}

	let ifHeader = request.headers.get('If');
	if (ifHeader) {
		for (const match of ifHeader.matchAll(/<([^>]+)>/g)) {
			let token = normalizeLockToken(match[1]);
			if (token !== '') {
				lockTokens.push(token);
			}
		}
	}

	return [...new Set(lockTokens)];
}

function hasAlwaysFalseIfCondition(request: Request): boolean {
	let ifHeader = request.headers.get('If') ?? '';
	return ifHeader.includes('<DAV:no-lock>') && !ifHeader.includes('Not <DAV:no-lock>');
}

export function extractLockOwner(body: string): string | undefined {
	let owner = body.match(/<owner(?:\s[^>]*)?>([\s\S]*?)<\/owner>/i)?.[1];
	if (owner === undefined) {
		return undefined;
	}

	owner = owner.trim();
	return owner === '' ? undefined : owner;
}

export async function assertLockPermission(
	request: Request,
	bucket: R2Bucket,
	resourcePath: string,
	options: { ignoreSharedLocksOnTarget?: boolean } = {},
): Promise<Response | null> {
	if (hasAlwaysFalseIfCondition(request)) {
		return createLockFailureResponse('preconditionFailed');
	}

	let lockTokens = getRequestLockTokens(request);
	for (const candidate of getAncestorPaths(resourcePath)) {
		let object = await bucket.head(candidate);
		let lockDetails = getScopedLockDetails(resourcePath, candidate, object?.customMetadata, options);
		if (lockDetails.length === 0) {
			continue;
		}

		if (!hasMatchingLockToken(lockDetails, lockTokens)) {
			return createLockFailureResponse('locked');
		}
	}

	return null;
}

export async function assertRecursiveDeletePermission(
	request: Request,
	bucket: R2Bucket,
	resourcePath: string,
): Promise<Response | null> {
	let lockResponse = await assertLockPermission(request, bucket, resourcePath);
	if (lockResponse !== null) {
		return lockResponse;
	}

	let lockTokens = getRequestLockTokens(request);
	let prefix = getCollectionPrefix(resourcePath);
	for await (let descendant of listAll(bucket, prefix, true)) {
		let lockDetails = getLockDetails(descendant.customMetadata);
		if (lockDetails.length > 0 && !hasMatchingLockToken(lockDetails, lockTokens)) {
			return createLockFailureResponse('locked');
		}
	}

	return null;
}

export async function findMatchingLock(
	request: Request,
	bucket: R2Bucket,
	resourcePath: string,
): Promise<{ resource: R2Object; lockDetails: LockDetails } | null> {
	let lockTokens = getRequestLockTokens(request);
	for (const current of getAncestorPaths(resourcePath)) {
		let resource = await bucket.head(current);
		let lockDetails = getScopedLockDetails(resourcePath, current, resource?.customMetadata).find((lockDetail) =>
			lockTokens.includes(lockDetail.token),
		);
		if (resource !== null && lockDetails !== undefined) {
			return { resource, lockDetails };
		}
	}
	return null;
}
