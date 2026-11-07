#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const DEAD_PROPERTY_PREFIX = 'dead_property:';
const DEFAULT_SIDECAR_PREFIX = '.__sidecar__';
const DEFAULT_LOCK_TIMEOUT = 3600;
const DEFAULT_OPTIONS = {
	allowLocal: false,
	binding: undefined,
	configPath: 'wrangler.toml',
	dryRun: false,
	environment: undefined,
	prefix: undefined,
};
const LEGACY_LOCK_METADATA_KEYS = {
	depth: 'lock_depth',
	expiresAt: 'lock_expires_at',
	owner: 'lock_owner',
	root: 'lock_root',
	scope: 'lock_scope',
	timeout: 'lock_timeout',
	token: 'lock_token',
};
const LOCK_SIGNATURE_FIELDS = ['token', 'owner', 'scope', 'depth', 'timeout', 'root'];
const LOCK_METADATA_KEY = 'lock_records';
const OPTION_HANDLERS = {
	'--allow-local': (options) => {
		options.allowLocal = true;
	},
	'--binding': (options, value) => {
		options.binding = value;
	},
	'--config': (options, value) => {
		options.configPath = value;
	},
	'--dry-run': (options) => {
		options.dryRun = true;
	},
	'--env': (options, value) => {
		options.environment = value;
	},
	'--help': () => {
		printUsage(0);
	},
	'--prefix': (options, value) => {
		options.prefix = normalizeResourcePath(value);
	},
};

function printUsage(exitCode) {
	const stream = exitCode === 0 ? process.stdout : process.stderr;
	stream.write(`Usage: node scripts/migrate-directory-sidecars.mjs [options]

Options:
  --config <path>     Wrangler config file to read. Default: wrangler.toml
  --env <name>        Wrangler environment name.
  --binding <name>    R2 binding name. Defaults to the only configured binding.
  --prefix <path>     Only migrate a specific directory prefix.
  --dry-run           Print planned changes without writing or deleting.
  --allow-local       Allow running against a local bucket binding.
  --help              Show this message.
`);
	process.exit(exitCode);
}

function parseArgs(argv) {
	const options = { ...DEFAULT_OPTIONS };

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		const handler = OPTION_HANDLERS[argument];
		if (!handler) {
			process.stderr.write(`Unknown option: ${argument}\n`);
			printUsage(1);
		}

		if (handler.length === 2) {
			const value = argv[index + 1];
			if (!value || value.startsWith('--')) {
				process.stderr.write(`Missing value for ${argument}\n`);
				printUsage(1);
			}
			handler(options, value);
			index += 1;
			continue;
		}

		handler(options);
	}

	return options;
}

function isPlainObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeResourcePath(resourcePath) {
	return String(resourcePath ?? '').replace(/^\/+|\/+$/g, '');
}

function getDirectorySidecarKey(resourcePath, sidecarPrefix) {
	const normalized = normalizeResourcePath(resourcePath);
	return normalized === '' ? `${sidecarPrefix}/.json` : `${sidecarPrefix}/${normalized}.json`;
}

function isReservedWebdavPath(resourcePath, sidecarPrefix) {
	return resourcePath === sidecarPrefix || resourcePath.startsWith(`${sidecarPrefix}/`);
}

function getConfiguredSidecarPrefix(config) {
	return normalizeResourcePath(config.vars?.SIDECAR_PREFIX) || DEFAULT_SIDECAR_PREFIX;
}

function readDeadProperties(metadata) {
	const props = {};

	for (const [key, value] of Object.entries(metadata)) {
		if (!key.startsWith(DEAD_PROPERTY_PREFIX)) {
			continue;
		}

		try {
			const parsed = JSON.parse(value);
			if (
				isPlainObject(parsed) &&
				typeof parsed.namespaceURI === 'string' &&
				typeof parsed.localName === 'string' &&
				(typeof parsed.prefix === 'string' || parsed.prefix === null) &&
				typeof parsed.valueXml === 'string'
			) {
				props[key] = parsed;
			}
		} catch {}
	}

	return Object.keys(props).length === 0 ? undefined : props;
}

function normalizeLockScope(scope) {
	return scope === 'shared' ? 'shared' : 'exclusive';
}

function normalizeLockDepth(depth) {
	return depth === 'infinity' ? 'infinity' : '0';
}

function getLockTimeout(timeout) {
	return typeof timeout === 'string' && timeout !== '' ? timeout : `Second-${DEFAULT_LOCK_TIMEOUT}`;
}

function getLockTimeoutSeconds(timeout) {
	let seconds = Number(String(timeout).match(/^Second-(\d+)$/i)?.[1] ?? NaN);
	return Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_LOCK_TIMEOUT;
}

function normalizeStoredLockDetails(lockDetails, now = Date.now()) {
	let timeout = getLockTimeout(lockDetails.timeout);
	let expiresAt = Number(lockDetails.expiresAt ?? 0);
	if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
		expiresAt = now + getLockTimeoutSeconds(timeout) * 1000;
	}
	if (expiresAt <= now) {
		return [];
	}

	return [
		{
			depth: normalizeLockDepth(lockDetails.depth),
			expiresAt,
			owner: lockDetails.owner,
			root: lockDetails.root ?? '/',
			scope: normalizeLockScope(lockDetails.scope),
			timeout,
			token: lockDetails.token,
		},
	];
}

function normalizeComparableLockDetails(lockDetails, now = Date.now()) {
	let expiresAt = Number(lockDetails.expiresAt ?? 0);
	if (Number.isFinite(expiresAt) && expiresAt > 0) {
		if (expiresAt <= now) {
			return [];
		}
	} else {
		expiresAt = null;
	}

	return [
		{
			depth: normalizeLockDepth(lockDetails.depth),
			expiresAt,
			owner: lockDetails.owner,
			root: lockDetails.root ?? '/',
			scope: normalizeLockScope(lockDetails.scope),
			timeout: getLockTimeout(lockDetails.timeout),
			token: lockDetails.token,
		},
	];
}

function readLegacyLocks(metadata, normalizeLock = normalizeStoredLockDetails) {
	const records = metadata[LOCK_METADATA_KEY];
	if (records !== undefined) {
		try {
			const parsed = JSON.parse(records);
			if (Array.isArray(parsed)) {
				return parsed.flatMap((lockDetails) =>
					lockDetails && typeof lockDetails === 'object' && typeof lockDetails.token === 'string' ? normalizeLock(lockDetails) : [],
				);
			}
		} catch {}
	}

	if (metadata[LEGACY_LOCK_METADATA_KEYS.token] === undefined) {
		return undefined;
	}

	const locks = normalizeLock({
		depth: metadata[LEGACY_LOCK_METADATA_KEYS.depth],
		expiresAt: metadata[LEGACY_LOCK_METADATA_KEYS.expiresAt],
		owner: metadata[LEGACY_LOCK_METADATA_KEYS.owner],
		root: metadata[LEGACY_LOCK_METADATA_KEYS.root],
		scope: metadata[LEGACY_LOCK_METADATA_KEYS.scope],
		timeout: metadata[LEGACY_LOCK_METADATA_KEYS.timeout],
		token: metadata[LEGACY_LOCK_METADATA_KEYS.token],
	});

	return locks.length === 0 ? undefined : locks;
}

function readComparableLegacyLocks(metadata) {
	const locks = readLegacyLocks(metadata, normalizeComparableLockDetails);
	return locks?.length ? locks : undefined;
}

export function readLegacyDirectoryMarker(metadata) {
	if (!metadata || metadata.resourcetype !== '<collection />') {
		return undefined;
	}

	const locks = readLegacyLocks(metadata);
	const props = readDeadProperties(metadata);
	return {
		kind: 'directory',
		...(locks === undefined ? {} : { locks }),
		...(props === undefined ? {} : { props }),
	};
}

function readComparableLegacyDirectoryMarker(metadata) {
	if (!metadata || metadata.resourcetype !== '<collection />') {
		return undefined;
	}

	const locks = readComparableLegacyLocks(metadata);
	const props = readDeadProperties(metadata);
	return {
		kind: 'directory',
		...(locks === undefined ? {} : { locks }),
		...(props === undefined ? {} : { props }),
	};
}

function parseDirectoryUploaded(value) {
	if (typeof value !== 'string') {
		return undefined;
	}
	let parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) {
		return undefined;
	}
	return new Date(parsed);
}

export function parseDirectorySidecar(payload) {
	try {
		const parsed = JSON.parse(payload);
		if (!isPlainObject(parsed) || parsed.kind !== 'directory') {
			return undefined;
		}

		const props = isPlainObject(parsed.props)
			? Object.fromEntries(
					Object.entries(parsed.props).filter(
						([, value]) =>
							isPlainObject(value) &&
							typeof value.namespaceURI === 'string' &&
							typeof value.localName === 'string' &&
							(typeof value.prefix === 'string' || value.prefix === null) &&
							typeof value.valueXml === 'string',
					),
				)
			: undefined;
		const locks = Array.isArray(parsed.locks)
			? parsed.locks.flatMap((lockDetails) =>
					lockDetails && typeof lockDetails === 'object' && typeof lockDetails.token === 'string'
						? normalizeStoredLockDetails(lockDetails)
						: [],
				)
			: undefined;
		const uploaded = parseDirectoryUploaded(parsed.uploaded);

		return {
			kind: 'directory',
			...(props && Object.keys(props).length > 0 ? { props } : {}),
			...(locks && locks.length > 0 ? { locks } : {}),
			...(uploaded !== undefined ? { uploaded } : {}),
		};
	} catch {
		return undefined;
	}
}

function canonicalizeSidecar(sidecar) {
	return {
		kind: 'directory',
		...(sidecar.props === undefined
			? {}
			: {
					props: Object.fromEntries(
						Object.keys(sidecar.props)
							.sort()
							.map((key) => [key, sidecar.props[key]]),
					),
				}),
		...(sidecar.locks === undefined
			? {}
			: {
					locks: [...sidecar.locks]
						.sort((left, right) =>
							`${getLockSignature(left)}:${left.expiresAt}`.localeCompare(
								`${getLockSignature(right)}:${right.expiresAt}`,
							),
						)
						.map((lockDetails) => ({
							depth: lockDetails.depth,
							expiresAt: lockDetails.expiresAt,
							owner: lockDetails.owner,
							root: lockDetails.root,
							scope: lockDetails.scope,
							timeout: lockDetails.timeout,
							token: lockDetails.token,
						})),
				}),
		...(sidecar.uploaded !== undefined ? { uploaded: sidecar.uploaded instanceof Date ? sidecar.uploaded.toISOString() : sidecar.uploaded } : {}),
	};
}

export function serializeDirectorySidecar(sidecar) {
	return JSON.stringify(canonicalizeSidecar(sidecar));
}

export function matchesSidecar(left, right) {
	return serializeDirectorySidecar(left) === serializeDirectorySidecar(right);
}

function matchesSidecarProps(left, right) {
	return matchesSidecar({ kind: 'directory', props: left }, { kind: 'directory', props: right });
}

function getLockSignature(lockDetails) {
	return JSON.stringify(LOCK_SIGNATURE_FIELDS.map((field) => lockDetails[field] ?? null));
}

function groupLockExpirations(lockDetailsList = []) {
	let groups = new Map();
	for (const lockDetails of lockDetailsList) {
		let signature = getLockSignature(lockDetails);
		let expirations = groups.get(signature);
		if (!expirations) {
			expirations = [];
			groups.set(signature, expirations);
		}
		expirations.push(lockDetails.expiresAt);
	}
	return groups;
}

function matchesComparableExpirations(existingExpirations, expectedExpirations) {
	if (existingExpirations.length !== expectedExpirations.length) {
		return false;
	}

	let counts = new Map();
	for (const expiresAt of existingExpirations) {
		counts.set(expiresAt, (counts.get(expiresAt) ?? 0) + 1);
	}

	let wildcardCount = 0;
	for (const expiresAt of expectedExpirations) {
		if (expiresAt === null) {
			wildcardCount += 1;
			continue;
		}

		let count = counts.get(expiresAt) ?? 0;
		if (count === 0) {
			return false;
		}
		if (count === 1) {
			counts.delete(expiresAt);
			continue;
		}
		counts.set(expiresAt, count - 1);
	}

	let remaining = 0;
	for (const count of counts.values()) {
		remaining += count;
	}
	return remaining === wildcardCount;
}

function matchesComparableLocks(existingLocks, expectedLocks) {
	let existingGroups = groupLockExpirations(existingLocks);
	let expectedGroups = groupLockExpirations(expectedLocks);
	if (existingGroups.size !== expectedGroups.size) {
		return false;
	}

	for (const [signature, expectedExpirations] of expectedGroups) {
		let existingExpirations = existingGroups.get(signature);
		if (!existingExpirations || !matchesComparableExpirations(existingExpirations, expectedExpirations)) {
			return false;
		}
	}
	return true;
}

export function matchesLegacyDirectoryMarker(existingSidecar, metadata) {
	let legacy = readComparableLegacyDirectoryMarker(metadata);
	return (
		legacy !== undefined &&
		matchesSidecarProps(existingSidecar.props, legacy.props) &&
		matchesComparableLocks(existingSidecar.locks, legacy.locks)
	);
}

async function* listAll(bucket, prefix = '') {
	let cursor;

	do {
		const listing = await bucket.list({
			cursor,
			// @ts-ignore R2 list include is supported at runtime.
			include: ['customMetadata'],
			prefix,
		});

		for (const object of listing.objects) {
			yield object;
		}

		cursor = listing.truncated ? listing.cursor : undefined;
	} while (cursor !== undefined);
}

function getSelectedBucket(config, bindingName) {
	if (!Array.isArray(config.r2_buckets) || config.r2_buckets.length === 0) {
		throw new Error('No R2 bucket bindings were found in the selected Wrangler config.');
	}

	if (bindingName) {
		const bucket = config.r2_buckets.find((entry) => entry.binding === bindingName);
		if (!bucket) {
			throw new Error(`R2 binding "${bindingName}" was not found in the selected Wrangler config.`);
		}
		return bucket;
	}

	if (config.r2_buckets.length > 1) {
		throw new Error('Multiple R2 bindings are configured. Re-run with --binding <name>.');
	}

	return config.r2_buckets[0];
}

function matchesPrefix(resourcePath, prefix) {
	return prefix === undefined || resourcePath === prefix || resourcePath.startsWith(`${prefix}/`);
}

function logAction(type, resourcePath, detail) {
	process.stdout.write(`[${type}] ${resourcePath}${detail ? ` ${detail}` : ''}\n`);
}

export async function main(argv = process.argv.slice(2)) {
	try {
		const options = parseArgs(argv);
		process.env.XDG_CONFIG_HOME ??= path.resolve('.tmp/xdg');
		const { getPlatformProxy, unstable_readConfig } = await import('wrangler');

		const config = await unstable_readConfig({
			config: options.configPath,
			env: options.environment,
		});
		const bucketConfig = getSelectedBucket(config, options.binding);
		const sidecarPrefix = getConfiguredSidecarPrefix(config);

		if (bucketConfig.remote !== true && !options.allowLocal) {
			throw new Error(
				`Binding "${bucketConfig.binding}" is not configured with remote = true. Add remote access in wrangler.toml or pass --allow-local for a local-only migration run.`,
			);
		}

		const platform = await getPlatformProxy({
			configPath: options.configPath,
			environment: options.environment,
		});

		try {
			const bucket = platform.env[bucketConfig.binding];
			if (!bucket || typeof bucket.list !== 'function') {
				throw new Error(`Binding "${bucketConfig.binding}" is not available as an R2 bucket.`);
			}

			const summary = {
				conflicts: 0,
				deletedLegacyMarkers: 0,
				legacyMarkers: 0,
				scannedObjects: 0,
				skippedByPrefix: 0,
				validatedSidecars: 0,
				writtenSidecars: 0,
			};

			for await (const object of listAll(bucket, options.prefix ?? '')) {
				summary.scannedObjects += 1;
				if (isReservedWebdavPath(object.key, sidecarPrefix)) {
					continue;
				}
				if (!matchesPrefix(object.key, options.prefix)) {
					summary.skippedByPrefix += 1;
					continue;
				}

				const metadata = object.customMetadata ?? (await bucket.head(object.key))?.customMetadata;
				const legacy = readLegacyDirectoryMarker(metadata);
				if (!legacy) {
					continue;
				}

				summary.legacyMarkers += 1;
				const sidecarKey = getDirectorySidecarKey(object.key, sidecarPrefix);
				const existingSidecarObject = await bucket.get(sidecarKey);
				if (existingSidecarObject === null) {
					logAction(options.dryRun ? 'plan' : 'write', object.key, `-> ${sidecarKey}`);
					if (!options.dryRun) {
						await bucket.put(sidecarKey, serializeDirectorySidecar({ ...legacy, uploaded: object.uploaded }));
						await bucket.delete(object.key);
					}
					summary.writtenSidecars += 1;
					summary.deletedLegacyMarkers += 1;
					continue;
				}

				const existingSidecar = parseDirectorySidecar(await existingSidecarObject.text());
				if (!existingSidecar) {
					logAction('conflict', object.key, '(existing sidecar is malformed)');
					summary.conflicts += 1;
					continue;
				}

				if (!matchesLegacyDirectoryMarker(existingSidecar, metadata)) {
					logAction('conflict', object.key, '(existing sidecar differs from legacy metadata)');
					summary.conflicts += 1;
					continue;
				}

				logAction(options.dryRun ? 'plan' : 'cleanup', object.key, '(sidecar already matches)');
				if (!options.dryRun) {
					await bucket.delete(object.key);
				}
				summary.validatedSidecars += 1;
				summary.deletedLegacyMarkers += 1;
			}

			process.stdout.write(`\nScanned objects: ${summary.scannedObjects}
Legacy markers: ${summary.legacyMarkers}
Sidecars written: ${summary.writtenSidecars}
Legacy markers deleted: ${summary.deletedLegacyMarkers}
Existing sidecars validated: ${summary.validatedSidecars}
Conflicts: ${summary.conflicts}
Mode: ${options.dryRun ? 'dry-run' : 'apply'}
Binding: ${bucketConfig.binding} (${bucketConfig.bucket_name})
Sidecar prefix: ${sidecarPrefix}
\n`);

			if (summary.conflicts > 0) {
				process.exitCode = 1;
			}
		} finally {
			await platform.dispose();
		}
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
