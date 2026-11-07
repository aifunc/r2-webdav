import {
	DEFAULT_LOCK_TIMEOUT,
	LOCK_METADATA_KEYS,
	LOCK_RECORDS_METADATA_KEY,
	MAX_LOCK_TIMEOUT,
	VALID_LOCK_DEPTHS,
} from '../shared/constants';
import { escapeXml } from '../shared/escape';
import { DEFAULT_SIDECAR_CONFIG, getSidecarPrefix } from '../shared/sidecar';
import { getDirectorySidecarKey, isDirectorySidecarKey, readDirectorySidecarState } from './directories';
import { decodeResourcePath, getAncestorPaths, getCollectionPrefix, getResourceHref } from './path';
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

async function readDirectorySidecarLockDetails(
	bucket: R2Bucket,
	resourcePath: string,
	sidecarConfig: SidecarConfig,
): Promise<{ exists: boolean; locks: LockDetails[] }> {
	let state = await readDirectorySidecarState(bucket, getDirectorySidecarKey(resourcePath, sidecarConfig));
	return { exists: state.exists, locks: state.sidecar?.locks ?? [] };
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

export function rewriteLockRoots(
	customMetadata: Record<string, string> | undefined,
	targetKey: string,
	isCollection: boolean,
): Record<string, string> {
	let lockDetails = getLockDetails(customMetadata).map((lockDetail) => ({
		...lockDetail,
		root: getResourceHref(targetKey, isCollection),
	}));
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

async function evaluateIfHeaderConditions(request: Request, bucket: R2Bucket): Promise<boolean | null> {
	let ifHeader = request.headers.get('If');
	if (ifHeader === null || ifHeader.trim() === '') {
		return null;
	}

	let conditionLists = parseIfHeader(ifHeader, request.url);
	if (conditionLists === null || conditionLists.length === 0) {
		return false;
	}

	let requestPath: string;
	try {
		requestPath = decodeResourcePath(new URL(request.url).pathname);
	} catch {
		return false;
	}
	let requestResource = await bucket.head(requestPath);
	// RFC 4918 §10.4.2：只要有一个条件列表为真即可；没有标签的列表作用于 Request-URI，
	// 带标签的列表作用于标签资源。token 条件此处先视为可满足，随后逐资源校验 token。
	for (const { conditions, tagPath } of conditionLists) {
		let resource = tagPath === null || tagPath === requestPath ? requestResource : await bucket.head(tagPath);
		if (matchEtagConditions(conditions, resource)) {
			return true;
		}
	}
	return false;
}

function collectPositiveLockTokens(conditions: IfHeaderStateCondition[]): string[] {
	return conditions.flatMap((condition) => {
		if (condition.kind !== 'token' || condition.negated) {
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
	options: { includeDirectTokens?: boolean } = {},
): { unsupported: boolean; tokens: string[] } {
	let conditionLists = parseIfHeader(request.headers.get('If'), request.url);
	if (conditionLists === null) {
		return { unsupported: true, tokens: [] };
	}

	let tokens = options.includeDirectTokens === false ? [] : getDirectRequestLockTokens(request);
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
	let ifHeaderResult = await evaluateIfHeaderConditions(request, bucket);
	if (ifHeaderResult === false) {
		return createLockFailureResponse('preconditionFailed');
	}
	let existingLockTokens = new Set<string>();
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
		for (const lockDetail of lockDetails) {
			existingLockTokens.add(lockDetail.token);
		}
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

	// RFC 4918 §10.4.1: If 头提交的正向锁 token 必须对应一条现存锁，否则该 If 条件为假 → 412。
	// Lock-Token 头是 UNLOCK 的操作参数而非 If 条件（§9.11），不参与此校验；
	// 无效 token 由 handleUnlock 经 findMatchingLock 返回 409。
	let requestLockTokens = getRequestLockTokensForTarget(request, requestResource, resourcePath, requestResource, {
		includeDirectTokens: false,
	});
	if (!requestLockTokens.unsupported) {
		for (const token of requestLockTokens.tokens) {
			if (!existingLockTokens.has(token)) {
				return createLockFailureResponse('preconditionFailed');
			}
		}
	}

	return null;
}

export async function assertNoDescendantLockConflicts(
	bucket: R2Bucket,
	resourcePath: string,
	sidecarConfig: SidecarConfig = DEFAULT_SIDECAR_CONFIG,
	requestedScope: LockDetails['scope'] = 'exclusive',
): Promise<Response | null> {
	let prefix = getCollectionPrefix(resourcePath);
	for await (let descendant of listAll(bucket, prefix, true)) {
		if (descendant.key === resourcePath) {
			continue;
		}
		let lockDetails = getLockDetails(descendant.customMetadata);
		if (lockDetails.length === 0 && descendant.customMetadata?.resourcetype === '<collection />') {
			let sidecar = (await readDirectorySidecarState(bucket, getDirectorySidecarKey(descendant.key, sidecarConfig)))
				.sidecar;
			lockDetails = sidecar?.locks ?? [];
		}
		if (lockDetails.some((lock) => requestedScope === 'exclusive' || lock.scope === 'exclusive')) {
			return createLockFailureResponse('locked');
		}
	}

	let sidecarPrefix = `${getSidecarPrefix(sidecarConfig)}/${resourcePath === '' ? '' : `${resourcePath}/`}`;
	for await (let object of listAll(bucket, sidecarPrefix, true)) {
		if (!isDirectorySidecarKey(object.key, sidecarConfig)) {
			continue;
		}
		if (getResourcePathFromSidecarKey(object.key, sidecarConfig) === resourcePath) {
			continue;
		}
		let sidecar = (await readDirectorySidecarState(bucket, object.key)).sidecar;
		if ((sidecar?.locks ?? []).some((lock) => requestedScope === 'exclusive' || lock.scope === 'exclusive')) {
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
		let sidecar = (await readDirectorySidecarState(bucket, object.key)).sidecar;
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

const LOCK_MUTATION_GUARD_LEASE_MS = 30_000;
const LOCK_MUTATION_GUARD_RETRY_MS = 15;
const LOCK_MUTATION_GUARD_ATTEMPTS = 40;

export interface LockMutationGuard {
	release(): Promise<void>;
}

function getLockMutationGuardKey(sidecarConfig: SidecarConfig): string {
	return `${getSidecarPrefix(sidecarConfig)}/.lock-mutation-guard`;
}

function waitForLockMutationGuard(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function acquireLockMutationGuard(
	bucket: R2Bucket,
	sidecarConfig: SidecarConfig = DEFAULT_SIDECAR_CONFIG,
): Promise<LockMutationGuard | null> {
	let key = getLockMutationGuardKey(sidecarConfig);
	let token = crypto.randomUUID();

	for (let attempt = 0; attempt < LOCK_MUTATION_GUARD_ATTEMPTS; attempt += 1) {
		let current = await bucket.get(key);
		let now = Date.now();
		let options: R2PutOptions;

		if (current === null) {
			options = { onlyIf: { etagDoesNotMatch: '*' } };
		} else {
			let expiresAt = 0;
			try {
				let parsed = JSON.parse(await current.text()) as { expiresAt?: unknown };
				if (typeof parsed.expiresAt === 'number') {
					expiresAt = parsed.expiresAt;
				}
			} catch {}
			if (expiresAt > now) {
				await waitForLockMutationGuard(LOCK_MUTATION_GUARD_RETRY_MS);
				continue;
			}
			options = { onlyIf: { etagMatches: current.etag } };
		}

		let stored = await bucket.put(
			key,
			JSON.stringify({ token, expiresAt: now + LOCK_MUTATION_GUARD_LEASE_MS }),
			options,
		);
		if (stored !== null) {
			return {
				async release(): Promise<void> {
					try {
						await bucket.put(key, JSON.stringify({ token, expiresAt: 0 }), {
							onlyIf: { etagMatches: stored.etag },
						});
					} catch {}
				},
			};
		}

		await waitForLockMutationGuard(LOCK_MUTATION_GUARD_RETRY_MS);
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
