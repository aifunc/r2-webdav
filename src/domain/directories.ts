import { DEAD_PROPERTY_PREFIX } from '../shared/constants.js';
import { DEFAULT_SIDECAR_CONFIG, getSidecarPrefix } from '../shared/sidecar';
import type {
	DeadProperty,
	DirectorySidecar,
	LegacyDirectoryMarker,
	LockDetails,
	SidecarConfig,
} from '../shared/types.js';
import { getLockDetails } from './locks.js';

const DIRECTORY_SIDECAR_SUFFIX = '.json';
const LOCK_SCOPES: LockDetails['scope'][] = ['exclusive', 'shared'];
const LOCK_DEPTHS: LockDetails['depth'][] = ['0', 'infinity'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeResourcePath(resourcePath: string): string {
	return resourcePath.replace(/^\/+|\/+$/g, '');
}

function isLockDetails(value: unknown): value is LockDetails {
	if (!isPlainObject(value)) {
		return false;
	}

	let scope = value.scope as LockDetails['scope'] | undefined;
	let depth = value.depth as LockDetails['depth'] | undefined;

	return (
		typeof value.token === 'string' &&
		(typeof value.owner === 'string' || value.owner === undefined) &&
		typeof value.timeout === 'string' &&
		typeof value.root === 'string' &&
		typeof value.expiresAt === 'number' &&
		Number.isFinite(value.expiresAt) &&
		LOCK_SCOPES.includes(scope as LockDetails['scope']) &&
		LOCK_DEPTHS.includes(depth as LockDetails['depth'])
	);
}

function isDeadProperty(value: unknown): value is DeadProperty {
	if (!isPlainObject(value)) {
		return false;
	}

	return (
		typeof value.namespaceURI === 'string' &&
		typeof value.localName === 'string' &&
		(value.prefix === null || typeof value.prefix === 'string') &&
		typeof value.valueXml === 'string'
	);
}

function parseDirectoryProps(value: unknown): DirectorySidecar['props'] | undefined {
	if (!isPlainObject(value)) {
		return undefined;
	}

	let props: DirectorySidecar['props'] = {};
	for (const [key, entry] of Object.entries(value)) {
		if (isDeadProperty(entry)) {
			props[key] = entry;
		}
	}

	return Object.keys(props).length === 0 ? undefined : props;
}

function parseDirectoryLocks(value: unknown): LockDetails[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}

	let locks: LockDetails[] = [];
	for (const entry of value) {
		if (isLockDetails(entry) && entry.expiresAt > Date.now()) {
			locks.push({
				token: entry.token,
				owner: entry.owner,
				scope: entry.scope,
				depth: entry.depth,
				timeout: entry.timeout,
				expiresAt: entry.expiresAt,
				root: entry.root,
			});
		}
	}

	return locks;
}

function buildDirectorySidecar(
	parsed: Record<string, unknown>,
	props: DirectorySidecar['props'] | undefined,
	locks: LockDetails[] | undefined,
	uploaded: Date | undefined,
): DirectorySidecar | undefined {
	if (parsed.kind !== 'directory') {
		return undefined;
	}

	let sidecar: DirectorySidecar = { kind: 'directory' };
	if (props !== undefined) {
		sidecar.props = props;
	}
	if (locks !== undefined) {
		sidecar.locks = locks;
	}
	if (uploaded !== undefined) {
		sidecar.uploaded = uploaded;
	}
	return sidecar;
}

export function getDirectorySidecarKey(
	resourcePath: string,
	sidecarConfig: SidecarConfig = DEFAULT_SIDECAR_CONFIG,
): string {
	let sidecarPrefix = getSidecarPrefix(sidecarConfig);
	let normalized = normalizeResourcePath(resourcePath);
	let base = normalized === '' ? `${sidecarPrefix}/` : `${sidecarPrefix}/${normalized}`;
	return `${base}${DIRECTORY_SIDECAR_SUFFIX}`;
}

export function isDirectorySidecarKey(key: string, sidecarConfig: SidecarConfig = DEFAULT_SIDECAR_CONFIG): boolean {
	let sidecarPrefix = getSidecarPrefix(sidecarConfig);
	return key.startsWith(`${sidecarPrefix}/`) && key.endsWith(DIRECTORY_SIDECAR_SUFFIX);
}

function parseDirectoryUploaded(value: unknown): Date | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	let parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) {
		return undefined;
	}
	return new Date(parsed);
}

export function parseDirectorySidecar(payload: string): DirectorySidecar | undefined {
	try {
		let parsed = JSON.parse(payload);
		if (!isPlainObject(parsed)) {
			return undefined;
		}
		let props = parseDirectoryProps(parsed.props);
		let locks = parseDirectoryLocks(parsed.locks);
		let uploaded = parseDirectoryUploaded(parsed.uploaded);
		return buildDirectorySidecar(parsed, props, locks, uploaded);
	} catch {
		return undefined;
	}
}

export function serializeDirectorySidecar(sidecar: DirectorySidecar): string {
	let payload: Record<string, unknown> = { kind: 'directory' };
	if (sidecar.props !== undefined) {
		payload.props = sidecar.props;
	}
	if (sidecar.locks !== undefined) {
		payload.locks = sidecar.locks;
	}
	if (sidecar.uploaded !== undefined) {
		payload.uploaded = sidecar.uploaded.toISOString();
	}
	return JSON.stringify(payload);
}

export type DirectorySidecarState = {
	exists: boolean;
	sidecar: DirectorySidecar | undefined;
	etag: string | undefined;
	uploaded: Date | undefined;
};

export async function readDirectorySidecarState(bucket: R2Bucket, sidecarKey: string): Promise<DirectorySidecarState> {
	let object = await bucket.get(sidecarKey);
	if (object === null) {
		return { exists: false, sidecar: undefined, etag: undefined, uploaded: undefined };
	}
	let sidecar = parseDirectorySidecar(await object.text());
	return {
		exists: true,
		sidecar,
		etag: object.etag,
		uploaded: sidecar?.uploaded ?? object.uploaded,
	};
}

export async function updateDirectorySidecar(
	bucket: R2Bucket,
	sidecarKey: string,
	update: (sidecar: DirectorySidecar | undefined, exists: boolean) => DirectorySidecar | Response,
	maxAttempts: number = 3,
): Promise<Response | null> {
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		let state = await readDirectorySidecarState(bucket, sidecarKey);
		let updated = update(state.sidecar, state.exists);
		if (updated instanceof Response) {
			return updated;
		}
		let stored = await bucket.put(
			sidecarKey,
			serializeDirectorySidecar(updated),
			state.exists && state.etag !== undefined
				? { onlyIf: { etagMatches: state.etag } }
				: // R2 的 put 条件失败返回 null；用 etagDoesNotMatch:'*' 把首次创建变成
					// create-if-absent，避免两个并发首次 LOCK/属性写都成功、后写覆盖先写。
					{ onlyIf: { etagDoesNotMatch: '*' } },
		);
		if (stored !== null) {
			return null;
		}
	}
	return new Response('Conflict', { status: 409 });
}

export function readLegacyDirectoryMarker(
	metadata: Record<string, string> | undefined,
): LegacyDirectoryMarker | undefined {
	if (metadata === undefined || metadata.resourcetype !== '<collection />') {
		return undefined;
	}

	let props: DirectorySidecar['props'] = {};
	for (const [key, value] of Object.entries(metadata)) {
		if (!key.startsWith(DEAD_PROPERTY_PREFIX)) {
			continue;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(value);
		} catch {
			continue;
		}

		if (isDeadProperty(parsed)) {
			props[key] = parsed;
		}
	}

	let locks = getLockDetails(metadata);

	return {
		props: Object.keys(props).length > 0 ? props : undefined,
		locks: locks.length > 0 ? locks : undefined,
	};
}

export function coalesceDirectoryMetadata(
	sidecar: DirectorySidecar | undefined,
	legacy: LegacyDirectoryMarker | undefined,
): DirectorySidecar | undefined {
	if (sidecar !== undefined) {
		return sidecar;
	}
	if (legacy === undefined) {
		return undefined;
	}
	return {
		kind: 'directory',
		props: legacy.props,
		locks: legacy.locks ?? [],
	};
}

export function legacyMarkerToSidecar(legacy: LegacyDirectoryMarker): DirectorySidecar {
	return {
		kind: 'directory',
		...(legacy.props === undefined ? {} : { props: legacy.props }),
		...(legacy.locks === undefined ? {} : { locks: legacy.locks }),
	};
}

function hasSameDirectoryProps(
	left: DirectorySidecar['props'] | undefined,
	right: DirectorySidecar['props'] | undefined,
): boolean {
	let leftProps = left ?? {};
	let rightProps = right ?? {};
	let leftKeys = Object.keys(leftProps);
	if (leftKeys.length !== Object.keys(rightProps).length) {
		return false;
	}

	return leftKeys.every((key) => {
		let rightProperty = rightProps[key];
		if (rightProperty === undefined) {
			return false;
		}
		let leftProperty = leftProps[key];
		return (
			leftProperty.namespaceURI === rightProperty.namespaceURI &&
			leftProperty.localName === rightProperty.localName &&
			leftProperty.prefix === rightProperty.prefix &&
			leftProperty.valueXml === rightProperty.valueXml
		);
	});
}

function hasSameDirectoryLocks(left: LockDetails[] | undefined, right: LockDetails[] | undefined): boolean {
	let leftLocks = left ?? [];
	let rightLocks = right ?? [];
	if (leftLocks.length !== rightLocks.length) {
		return false;
	}

	return leftLocks.every((leftLock, index) => {
		let rightLock = rightLocks[index];
		return (
			leftLock.token === rightLock.token &&
			leftLock.owner === rightLock.owner &&
			leftLock.scope === rightLock.scope &&
			leftLock.depth === rightLock.depth &&
			leftLock.timeout === rightLock.timeout &&
			leftLock.expiresAt === rightLock.expiresAt &&
			leftLock.root === rightLock.root
		);
	});
}

function hasSameDirectoryState(left: DirectorySidecar, right: DirectorySidecar): boolean {
	return hasSameDirectoryProps(left.props, right.props) && hasSameDirectoryLocks(left.locks, right.locks);
}

export function getLegacyDirectoryMigrationPlan(
	existingSidecar: DirectorySidecar | undefined,
	legacy: LegacyDirectoryMarker,
):
	| { action: 'write-sidecar'; sidecar: DirectorySidecar }
	| { action: 'delete-legacy-marker' }
	| { action: 'conflict' } {
	let migrated = legacyMarkerToSidecar(legacy);
	return existingSidecar === undefined
		? { action: 'write-sidecar', sidecar: migrated }
		: hasSameDirectoryState(existingSidecar, migrated)
			? { action: 'delete-legacy-marker' }
			: { action: 'conflict' };
}

export function stripDirectoryLocks(sidecar: DirectorySidecar): DirectorySidecar {
	if (sidecar.locks === undefined || sidecar.locks.length === 0) {
		return sidecar;
	}
	return sidecar.props === undefined ? { kind: 'directory' } : { kind: 'directory', props: sidecar.props };
}
