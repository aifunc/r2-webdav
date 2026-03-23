import {
	DEFAULT_LOCK_TIMEOUT,
	LOCK_METADATA_KEYS,
	LOCK_RECORDS_METADATA_KEY,
	MAX_LOCK_TIMEOUT,
	VALID_LOCK_DEPTHS,
} from '../shared/constants';
import { escapeXml } from '../shared/escape';
import { DEFAULT_SIDECAR_CONFIG, getSidecarPrefix } from '../shared/sidecar';
import { getDirectorySidecarKey, isDirectorySidecarKey, parseDirectorySidecar } from './directories';
import { decodeResourcePath, getAncestorPaths, getCollectionPrefix } from './path';
import { listAll } from './storage';
import type { DirectorySidecar, LockDetails, SidecarConfig } from '../shared/types';

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
	return filterScopedLockDetails(resourcePath, candidate, getLockDetails(customMetadata), options);
}

function filterScopedLockDetails(
	resourcePath: string,
	candidate: string,
	lockDetails: LockDetails[],
	options: { ignoreSharedLocksOnTarget?: boolean } = {},
): LockDetails[] {
	return lockDetails.filter(
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

async function readDirectorySidecarFromKey(
	bucket: R2Bucket,
	sidecarKey: string,
): Promise<DirectorySidecar | undefined> {
	let object = await bucket.get(sidecarKey);
	if (object === null) {
		return undefined;
	}
	return parseDirectorySidecar(await new Response(object.body).text());
}

async function readDirectorySidecarLockDetails(
	bucket: R2Bucket,
	resourcePath: string,
	sidecarConfig: SidecarConfig,
): Promise<{ exists: boolean; locks: LockDetails[] }> {
	let sidecarKey = getDirectorySidecarKey(resourcePath, sidecarConfig);
	let object = await bucket.get(sidecarKey);
	if (object === null) {
		return { exists: false, locks: [] };
	}
	let payload = await new Response(object.body).text();
	let sidecar = parseDirectorySidecar(payload);
	return { exists: true, locks: sidecar?.locks ?? [] };
}

export async function readLockState(
	bucket: R2Bucket,
	resourcePath: string,
	sidecarConfig: SidecarConfig = DEFAULT_SIDECAR_CONFIG,
): Promise<{
	resourcePath: string;
	resource: R2Object | null;
	locks: LockDetails[];
	sidecarKey: string | null;
	sidecarLocks: LockDetails[];
	objectLocks: LockDetails[];
	sidecarExists: boolean;
}> {
	let sidecarKey = getDirectorySidecarKey(resourcePath, sidecarConfig);
	let [resource, sidecarResult] = await Promise.all([
		bucket.head(resourcePath),
		readDirectorySidecarLockDetails(bucket, resourcePath, sidecarConfig),
	]);
	let sidecarLocks = sidecarResult.locks;
	let objectLocks = getLockDetails(resource?.customMetadata);
	if (resource !== null && resource.customMetadata?.resourcetype !== '<collection />') {
		sidecarLocks = [];
		sidecarResult = { exists: false, locks: [] };
	}
	let locks = sidecarResult.exists ? sidecarLocks : objectLocks;
	return {
		resourcePath,
		resource,
		locks,
		sidecarKey: sidecarResult.exists ? sidecarKey : null,
		sidecarLocks,
		objectLocks: sidecarResult.exists ? [] : objectLocks,
		sidecarExists: sidecarResult.exists,
	};
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

function getDirectRequestLockTokens(request: Request): string[] {
	let lockTokens: string[] = [];
	let directLockToken = request.headers.get('Lock-Token');
	if (directLockToken) {
		lockTokens.push(normalizeLockToken(directLockToken));
	}

	return [...new Set(lockTokens)];
}

type IfHeaderStateCondition = {
	kind: 'token' | 'etag';
	negated: boolean;
	value: string;
};

type IfHeaderConditionList = {
	conditions: IfHeaderStateCondition[];
	tagPath: string | null;
};

function skipWhitespace(value: string, index: number): number {
	while (index < value.length && /\s/u.test(value[index])) {
		index++;
	}
	return index;
}

function readBracketedValue(
	value: string,
	index: number,
	open: string,
	close: string,
): { nextIndex: number; value: string } | null {
	if (value[index] !== open) {
		return null;
	}

	let nextIndex = value.indexOf(close, index + 1);
	if (nextIndex === -1) {
		return null;
	}

	return {
		nextIndex: nextIndex + 1,
		value: value.slice(index + 1, nextIndex),
	};
}

function parseIfHeaderTagPath(tagValue: string, requestUrl: string): string | null {
	try {
		let taggedUrl = new URL(tagValue, requestUrl);
		if (taggedUrl.origin !== new URL(requestUrl).origin) {
			return null;
		}
		return decodeResourcePath(taggedUrl.pathname);
	} catch {
		return null;
	}
}

function parseIfHeader(ifHeader: string | null, requestUrl: string): IfHeaderConditionList[] | null {
	let value = ifHeader?.trim() ?? '';
	if (value === '') {
		return [];
	}

	let conditionLists: IfHeaderConditionList[] = [];
	let index = 0;
	while (index < value.length) {
		index = skipWhitespace(value, index);
		if (index >= value.length) {
			return conditionLists;
		}

		let tagPath: string | null = null;
		if (value[index] === '<') {
			let taggedResource = readBracketedValue(value, index, '<', '>');
			if (taggedResource === null) {
				return null;
			}
			tagPath = parseIfHeaderTagPath(taggedResource.value, requestUrl);
			if (tagPath === null) {
				return null;
			}
			index = skipWhitespace(value, taggedResource.nextIndex);
		}

		let sawConditionList = false;
		while (value[index] === '(') {
			sawConditionList = true;
			index++;
			let conditions: IfHeaderStateCondition[] = [];

			while (index < value.length) {
				index = skipWhitespace(value, index);
				if (index >= value.length) {
					return null;
				}
				if (value[index] === ')') {
					if (conditions.length === 0) {
						return null;
					}
					index++;
					break;
				}

				let negated = false;
				if (value.slice(index, index + 3).toLowerCase() === 'not' && /\s/u.test(value[index + 3] ?? '')) {
					negated = true;
					index = skipWhitespace(value, index + 3);
				}

				let token = readBracketedValue(value, index, '<', '>');
				if (token !== null) {
					conditions.push({ kind: 'token', negated, value: token.value });
					index = token.nextIndex;
					continue;
				}

				let etag = readBracketedValue(value, index, '[', ']');
				if (etag !== null) {
					conditions.push({ kind: 'etag', negated, value: etag.value });
					index = etag.nextIndex;
					continue;
				}

				return null;
			}

			conditionLists.push({ conditions, tagPath });
			index = skipWhitespace(value, index);
		}

		if (!sawConditionList) {
			return null;
		}
	}

	return conditionLists;
}

function getEntityTags(resource: R2Object | null): string[] {
	let etag = resource?.httpEtag ?? (resource ? `"${resource.etag}"` : undefined);
	return etag === undefined ? [] : [etag];
}

function matchEtagConditions(conditions: IfHeaderStateCondition[], resource: R2Object | null): boolean {
	let entityTags = getEntityTags(resource);
	return conditions
		.filter((condition) => condition.kind === 'etag')
		.every((condition) =>
			condition.negated ? !entityTags.includes(condition.value) : entityTags.includes(condition.value),
		);
}

function collectPositiveLockTokens(conditions: IfHeaderStateCondition[]): string[] {
	if (
		conditions.some(
			(condition) =>
				condition.kind === 'token' && !condition.negated && condition.value.toLowerCase() === 'dav:no-lock',
		)
	) {
		return [];
	}

	return conditions.flatMap((condition) => {
		if (condition.kind !== 'token' || condition.negated || condition.value.toLowerCase() === 'dav:no-lock') {
			return [];
		}

		let token = normalizeLockToken(condition.value);
		return token === '' ? [] : [token];
	});
}

export function getRequestLockTokensForTarget(
	request: Request,
	requestResource: R2Object | null,
	targetPath: string,
	targetResource: R2Object | null,
): { unsupported: boolean; tokens: string[] } {
	let conditionLists = parseIfHeader(request.headers.get('If'), request.url);
	if (conditionLists === null) {
		return { unsupported: true, tokens: [] };
	}

	let tokens = getDirectRequestLockTokens(request);
	for (const { conditions, tagPath } of conditionLists) {
		if (
			conditions.some(
				(condition) =>
					condition.kind === 'token' && condition.negated && condition.value.toLowerCase() !== 'dav:no-lock',
			)
		) {
			return { unsupported: true, tokens: [] };
		}
		if (tagPath !== null && tagPath !== targetPath) {
			continue;
		}

		let resource = tagPath === null ? requestResource : targetResource;
		if (!matchEtagConditions(conditions, resource)) {
			continue;
		}

		tokens.push(...collectPositiveLockTokens(conditions));
	}

	return { unsupported: false, tokens: [...new Set(tokens)] };
}

function getResourcePathFromSidecarKey(key: string, sidecarConfig: SidecarConfig): string {
	return key.slice(`${getSidecarPrefix(sidecarConfig)}/`.length, -'.json'.length);
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
	sidecarConfig: SidecarConfig = DEFAULT_SIDECAR_CONFIG,
	options: { ignoreSharedLocksOnTarget?: boolean } = {},
): Promise<Response | null> {
	let requestResource = resourcePath === '' ? null : await bucket.head(resourcePath);
	for (const candidate of getAncestorPaths(resourcePath)) {
		let [resource, sidecarResult] = await Promise.all([
			bucket.head(candidate),
			readDirectorySidecarLockDetails(bucket, candidate, sidecarConfig),
		]);
		if (resource !== null && resource.customMetadata?.resourcetype !== '<collection />') {
			sidecarResult = { exists: false, locks: [] };
		}
		let lockDetails = sidecarResult.exists
			? filterScopedLockDetails(resourcePath, candidate, sidecarResult.locks, options)
			: getScopedLockDetails(resourcePath, candidate, resource?.customMetadata, options);
		if (lockDetails.length === 0) {
			continue;
		}

		let requestLockTokens = getRequestLockTokensForTarget(request, requestResource, candidate, resource);
		if (requestLockTokens.unsupported) {
			return createLockFailureResponse('preconditionFailed');
		}
		if (!hasMatchingLockToken(lockDetails, requestLockTokens.tokens)) {
			return createLockFailureResponse('locked');
		}
	}

	return null;
}

export async function assertRecursiveDeletePermission(
	request: Request,
	bucket: R2Bucket,
	resourcePath: string,
	sidecarConfig: SidecarConfig = DEFAULT_SIDECAR_CONFIG,
): Promise<Response | null> {
	let lockResponse = await assertLockPermission(request, bucket, resourcePath, sidecarConfig);
	if (lockResponse !== null) {
		return lockResponse;
	}

	let requestResource = resourcePath === '' ? null : await bucket.head(resourcePath);
	let prefix = getCollectionPrefix(resourcePath);
	for await (let descendant of listAll(bucket, prefix, true)) {
		let lockDetails = getLockDetails(descendant.customMetadata);
		if (lockDetails.length > 0) {
			if (descendant.customMetadata?.resourcetype === '<collection />') {
				let sidecarKey = getDirectorySidecarKey(descendant.key, sidecarConfig);
				let sidecarObject = await bucket.get(sidecarKey);
				if (sidecarObject !== null) {
					continue;
				}
			}
			let requestLockTokens = getRequestLockTokensForTarget(request, requestResource, descendant.key, descendant);
			if (requestLockTokens.unsupported) {
				return createLockFailureResponse('preconditionFailed');
			}
			if (!hasMatchingLockToken(lockDetails, requestLockTokens.tokens)) {
				return createLockFailureResponse('locked');
			}
		}
	}

	let sidecarPrefix = `${getSidecarPrefix(sidecarConfig)}/${resourcePath === '' ? '' : `${resourcePath}/`}`;
	for await (let object of listAll(bucket, sidecarPrefix, true)) {
		if (!isDirectorySidecarKey(object.key, sidecarConfig)) {
			continue;
		}
		let sidecar = await readDirectorySidecarFromKey(bucket, object.key);
		let lockDetails = sidecar?.locks ?? [];
		if (lockDetails.length === 0) {
			continue;
		}

		let currentPath = getResourcePathFromSidecarKey(object.key, sidecarConfig);
		let requestLockTokens = getRequestLockTokensForTarget(
			request,
			requestResource,
			currentPath,
			await bucket.head(currentPath),
		);
		if (requestLockTokens.unsupported) {
			return createLockFailureResponse('preconditionFailed');
		}
		if (!hasMatchingLockToken(lockDetails, requestLockTokens.tokens)) {
			return createLockFailureResponse('locked');
		}
	}

	return null;
}

export async function findMatchingLock(
	request: Request,
	bucket: R2Bucket,
	resourcePath: string,
	sidecarConfig: SidecarConfig = DEFAULT_SIDECAR_CONFIG,
): Promise<{ resource: R2Object | null; lockDetails: LockDetails; sidecarKey: string | null } | null> {
	let requestResource = resourcePath === '' ? null : await bucket.head(resourcePath);
	for (const current of getAncestorPaths(resourcePath)) {
		let [resource, sidecarResult] = await Promise.all([
			bucket.head(current),
			readDirectorySidecarLockDetails(bucket, current, sidecarConfig),
		]);
		if (resource !== null && resource.customMetadata?.resourcetype !== '<collection />') {
			sidecarResult = { exists: false, locks: [] };
		}
		let requestLockTokens = getRequestLockTokensForTarget(request, requestResource, current, resource);
		if (requestLockTokens.unsupported) {
			return null;
		}
		if (!sidecarResult.exists) {
			let lockDetails = getScopedLockDetails(resourcePath, current, resource?.customMetadata).find((lockDetail) =>
				requestLockTokens.tokens.includes(lockDetail.token),
			);
			if (lockDetails !== undefined) {
				return { resource, lockDetails, sidecarKey: null };
			}
			continue;
		}

		let sidecarLockDetails = filterScopedLockDetails(resourcePath, current, sidecarResult.locks).find((lockDetail) =>
			requestLockTokens.tokens.includes(lockDetail.token),
		);
		if (sidecarLockDetails !== undefined) {
			return {
				resource,
				lockDetails: sidecarLockDetails,
				sidecarKey: getDirectorySidecarKey(current, sidecarConfig),
			};
		}
	}
	return null;
}
