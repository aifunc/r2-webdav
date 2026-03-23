#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';

const DEAD_PROPERTY_PREFIX = 'dead_property:';
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

function getDirectorySidecarKey(resourcePath) {
	const normalized = normalizeResourcePath(resourcePath);
	return normalized === '' ? '.__webdav__/directories/.json' : `.__webdav__/directories/${normalized}.json`;
}

function isReservedWebdavPath(resourcePath) {
	return resourcePath === '.__webdav__' || resourcePath.startsWith('.__webdav__/');
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

function normalizeStoredLockDetails(lockDetails) {
	let expiresAt = Number(lockDetails.expiresAt ?? 0);
	if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
		expiresAt = Date.now() + DEFAULT_LOCK_TIMEOUT * 1000;
	}
	if (expiresAt <= Date.now()) {
		return [];
	}

	return [
		{
			depth: normalizeLockDepth(lockDetails.depth),
			expiresAt,
			owner: lockDetails.owner,
			root: lockDetails.root ?? '/',
			scope: normalizeLockScope(lockDetails.scope),
			timeout: lockDetails.timeout ?? `Second-${DEFAULT_LOCK_TIMEOUT}`,
			token: lockDetails.token,
		},
	];
}

function readLegacyLocks(metadata) {
	const records = metadata[LOCK_METADATA_KEY];
	if (records !== undefined) {
		try {
			const parsed = JSON.parse(records);
			if (Array.isArray(parsed)) {
				return parsed.flatMap((lockDetails) =>
					lockDetails && typeof lockDetails === 'object' && typeof lockDetails.token === 'string'
						? normalizeStoredLockDetails(lockDetails)
						: [],
				);
			}
		} catch {}
	}

	if (metadata[LEGACY_LOCK_METADATA_KEYS.token] === undefined) {
		return undefined;
	}

	const locks = normalizeStoredLockDetails({
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

function readLegacyDirectoryMarker(metadata) {
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

function parseDirectorySidecar(payload) {
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

		return {
			kind: 'directory',
			...(props && Object.keys(props).length > 0 ? { props } : {}),
			...(locks && locks.length > 0 ? { locks } : {}),
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
					locks: sidecar.locks.map((lockDetails) => ({
						depth: lockDetails.depth,
						expiresAt: lockDetails.expiresAt,
						owner: lockDetails.owner,
						root: lockDetails.root,
						scope: lockDetails.scope,
						timeout: lockDetails.timeout,
						token: lockDetails.token,
					})),
				}),
	};
}

function serializeDirectorySidecar(sidecar) {
	return JSON.stringify(canonicalizeSidecar(sidecar));
}

function matchesSidecar(left, right) {
	return serializeDirectorySidecar(left) === serializeDirectorySidecar(right);
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

try {
	const options = parseArgs(process.argv.slice(2));
	process.env.XDG_CONFIG_HOME ??= path.resolve('.tmp/xdg');
	const { getPlatformProxy, unstable_readConfig } = await import('wrangler');

	const config = await unstable_readConfig({
		config: options.configPath,
		env: options.environment,
	});
	const bucketConfig = getSelectedBucket(config, options.binding);

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
			if (isReservedWebdavPath(object.key)) {
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
			const sidecarKey = getDirectorySidecarKey(object.key);
			const existingSidecarObject = await bucket.get(sidecarKey);
			if (existingSidecarObject === null) {
				logAction(options.dryRun ? 'plan' : 'write', object.key, `-> ${sidecarKey}`);
				if (!options.dryRun) {
					await bucket.put(sidecarKey, serializeDirectorySidecar(legacy));
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

			if (!matchesSidecar(existingSidecar, legacy)) {
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
