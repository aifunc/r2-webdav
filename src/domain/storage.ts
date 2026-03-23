import { DEAD_PROPERTY_PREFIX } from '../shared/constants';
import { DEFAULT_SIDECAR_CONFIG, getSidecarPrefix } from '../shared/sidecar';
import {
	getDirectorySidecarKey,
	isDirectorySidecarKey,
	legacyMarkerToSidecar,
	parseDirectorySidecar,
	readLegacyDirectoryMarker,
	serializeDirectorySidecar,
} from './directories';
import { stripLockMetadata, withLockMetadata } from './locks';
import {
	getCollectionPrefix,
	isCollectionObject,
	isReservedWebdavNamespace,
	isSameOrDescendantPath,
	joinResourcePath,
	trimTrailingSlash,
} from './path';
import type { DirectorySidecar, SidecarConfig } from '../shared/types';

const DIRECTORY_SIDECAR_SUFFIX = '.json';
const LIST_RETRYABLE_ERROR_FRAGMENT = 'Unspecified error (0)';
const MAX_BUCKET_LIST_ATTEMPTS = 2;

export type ListedResource = {
	key: string;
	object: R2Object | null;
	isCollection: boolean;
};

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRetryableBucketListError(error: unknown): boolean {
	return getErrorMessage(error).includes(LIST_RETRYABLE_ERROR_FRAGMENT);
}

async function listBucket(
	bucket: R2Bucket,
	options: R2ListOptions,
	context: string,
): Promise<Awaited<ReturnType<R2Bucket['list']>>> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await bucket.list(options);
		} catch (error) {
			console.error('R2 list failed', {
				attempt,
				context,
				cursor: options.cursor ?? null,
				delimiter: options.delimiter ?? null,
				error: getErrorMessage(error),
				prefix: options.prefix ?? '',
			});
			if (attempt >= MAX_BUCKET_LIST_ATTEMPTS || !isRetryableBucketListError(error)) {
				throw error;
			}
		}
	}
}

function getDirectorySidecarRoot(sidecarConfig: SidecarConfig): string {
	return `${getSidecarPrefix(sidecarConfig)}/`;
}

function addListedResource(entries: Map<string, ListedResource>, entry: ListedResource): void {
	let existing = entries.get(entry.key);
	if (existing?.object) {
		return;
	}
	if (entry.object !== null) {
		entries.set(entry.key, entry);
		return;
	}
	if (!existing) {
		entries.set(entry.key, entry);
	}
}

function parseDirectorySidecarPath(key: string, sidecarConfig: SidecarConfig): string | null {
	let directorySidecarRoot = getDirectorySidecarRoot(sidecarConfig);
	if (!isDirectorySidecarKey(key, sidecarConfig) || !key.startsWith(directorySidecarRoot)) {
		return null;
	}
	return key.slice(directorySidecarRoot.length, -DIRECTORY_SIDECAR_SUFFIX.length);
}

function isDirectChildPath(parentPath: string, childPath: string): boolean {
	if (parentPath === '') {
		return childPath !== '' && !childPath.includes('/');
	}
	if (!childPath.startsWith(`${parentPath}/`)) {
		return false;
	}
	let remainder = childPath.slice(parentPath.length + 1);
	return remainder !== '' && !remainder.includes('/');
}

async function* listDirectorySidecarChildren(
	bucket: R2Bucket,
	resourcePath: string,
	sidecarConfig: SidecarConfig,
): AsyncGenerator<{ resourcePath: string; sidecarKey: string }> {
	let directorySidecarRoot = getDirectorySidecarRoot(sidecarConfig);
	let prefix = resourcePath === '' ? directorySidecarRoot : `${directorySidecarRoot}${resourcePath}/`;
	let cursor: string | undefined = undefined;
	do {
		let r2Objects = await listBucket(
			bucket,
			{
				prefix,
				delimiter: '/',
				cursor,
			},
			'listDirectorySidecarChildren',
		);

		for (let object of r2Objects.objects) {
			let sidecarPath = parseDirectorySidecarPath(object.key, sidecarConfig);
			if (sidecarPath === null || !isDirectChildPath(resourcePath, sidecarPath)) {
				continue;
			}
			yield { resourcePath: sidecarPath, sidecarKey: object.key };
		}

		if (r2Objects.truncated) {
			cursor = r2Objects.cursor;
		}
	} while (cursor !== undefined);
}

async function hasNonInternalDescendants(
	bucket: R2Bucket,
	resourcePath: string,
	sidecarConfig: SidecarConfig,
): Promise<boolean> {
	let prefix = getCollectionPrefix(resourcePath);
	for await (let object of listAll(bucket, prefix, true)) {
		if (!isReservedWebdavNamespace(object.key, sidecarConfig)) {
			return true;
		}
	}
	return false;
}

async function hasSidecarDescendants(
	bucket: R2Bucket,
	resourcePath: string,
	sidecarConfig: SidecarConfig,
): Promise<boolean> {
	let directorySidecarRoot = getDirectorySidecarRoot(sidecarConfig);
	let prefix = resourcePath === '' ? directorySidecarRoot : `${directorySidecarRoot}${resourcePath}/`;
	for await (let object of listAll(bucket, prefix, true)) {
		if (isDirectorySidecarKey(object.key, sidecarConfig)) {
			return true;
		}
	}
	return false;
}

async function readDirectorySidecarStateFromKey(
	bucket: R2Bucket,
	sidecarKey: string,
): Promise<{ exists: boolean; sidecar: DirectorySidecar | undefined; uploaded: Date | undefined }> {
	let object = await bucket.get(sidecarKey);
	if (object === null) {
		return { exists: false, sidecar: undefined, uploaded: undefined };
	}
	let uploaded = object.uploaded ?? (await bucket.head(sidecarKey))?.uploaded;
	return {
		exists: true,
		sidecar: parseDirectorySidecar(await new Response(object.body).text()),
		uploaded,
	};
}

async function readDirectorySidecar(
	bucket: R2Bucket,
	resourcePath: string,
	sidecarConfig: SidecarConfig,
): Promise<{ exists: boolean; sidecar: DirectorySidecar | undefined; uploaded: Date | undefined }> {
	return readDirectorySidecarStateFromKey(bucket, getDirectorySidecarKey(resourcePath, sidecarConfig));
}

async function* listDirectorySidecarEntries(
	bucket: R2Bucket,
	resourcePath: string,
	sidecarConfig: SidecarConfig,
): AsyncGenerator<{ resourcePath: string; sidecarKey: string }> {
	let directorySidecarRoot = getDirectorySidecarRoot(sidecarConfig);
	let prefix = resourcePath === '' ? directorySidecarRoot : `${directorySidecarRoot}${resourcePath}`;
	for await (let object of listAll(bucket, prefix, true)) {
		let sidecarPath = parseDirectorySidecarPath(object.key, sidecarConfig);
		if (sidecarPath === null || !isSameOrDescendantPath(resourcePath, sidecarPath)) {
			continue;
		}
		yield { resourcePath: sidecarPath, sidecarKey: object.key };
	}
}

function getTransferTargetDirectoryPath(sourcePath: string, destination: string, entryPath: string): string {
	if (entryPath === sourcePath) {
		return destination;
	}
	if (sourcePath === '') {
		return joinResourcePath(destination, entryPath);
	}
	return joinResourcePath(destination, entryPath.slice(sourcePath.length + 1));
}

async function writeDirectorySidecar(
	bucket: R2Bucket,
	resourcePath: string,
	sidecar: DirectorySidecar,
	sidecarConfig: SidecarConfig,
): Promise<void> {
	await bucket.put(getDirectorySidecarKey(resourcePath, sidecarConfig), serializeDirectorySidecar(sidecar));
}

function stripDeadProperties(metadata: Record<string, string>): Record<string, string> {
	for (const key of Object.keys(metadata)) {
		if (key.startsWith(DEAD_PROPERTY_PREFIX)) {
			delete metadata[key];
		}
	}
	return metadata;
}

function mergeDirectoryMetadata(
	baseMetadata: Record<string, string> | undefined,
	directory: DirectorySidecar | undefined,
): Record<string, string> | undefined {
	if (directory === undefined) {
		return baseMetadata;
	}

	let metadata = baseMetadata ? { ...baseMetadata } : {};
	metadata.resourcetype = '<collection />';
	metadata = stripDeadProperties(metadata);
	metadata = stripLockMetadata(metadata);

	if (directory.props !== undefined) {
		for (const [key, property] of Object.entries(directory.props)) {
			metadata[key] = JSON.stringify(property);
		}
	}

	if (directory.locks !== undefined) {
		metadata = withLockMetadata(metadata, directory.locks);
	}

	return metadata;
}

function createVirtualDirectoryObject(
	key: string,
	customMetadata: Record<string, string>,
	uploaded: Date | undefined,
): R2Object {
	return {
		key,
		size: 0,
		uploaded: uploaded ?? new Date(0),
		httpMetadata: {},
		customMetadata,
	} as R2Object;
}

async function resolveVirtualCollection(
	bucket: R2Bucket,
	resourcePath: string,
	sidecarConfig: SidecarConfig,
): Promise<R2Object | null> {
	let sidecarResult = await readDirectorySidecar(bucket, resourcePath, sidecarConfig);
	if (sidecarResult.exists) {
		let directoryMetadata = mergeDirectoryMetadata(undefined, sidecarResult.sidecar ?? { kind: 'directory' });
		if (directoryMetadata !== undefined) {
			return createVirtualDirectoryObject(resourcePath, directoryMetadata, sidecarResult.uploaded);
		}
		return createVirtualDirectoryObject(resourcePath, { resourcetype: '<collection />' }, sidecarResult.uploaded);
	}

	return null;
}

export async function* listAll(bucket: R2Bucket, prefix: string, isRecursive: boolean = false) {
	let cursor: string | undefined = undefined;
	do {
		let r2Objects = await listBucket(
			bucket,
			{
				prefix,
				delimiter: isRecursive ? undefined : '/',
				cursor,
				// @ts-ignore https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2listoptions
				include: ['httpMetadata', 'customMetadata'],
			},
			'listAll',
		);

		for (let object of r2Objects.objects) {
			yield object;
		}

		if (r2Objects.truncated) {
			cursor = r2Objects.cursor;
		}
	} while (cursor !== undefined);
}

export async function* listCollectionChildren(
	bucket: R2Bucket,
	resourcePath: string,
	sidecarConfig: SidecarConfig = DEFAULT_SIDECAR_CONFIG,
): AsyncGenerator<ListedResource> {
	let entries = new Map<string, ListedResource>();
	let prefix = getCollectionPrefix(resourcePath);
	let cursor: string | undefined = undefined;
	do {
		let r2Objects = await listBucket(
			bucket,
			{
				prefix,
				delimiter: '/',
				cursor,
				// @ts-ignore https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2listoptions
				include: ['httpMetadata', 'customMetadata'],
			},
			'listCollectionChildren',
		);

		for (let object of r2Objects.objects) {
			if (isReservedWebdavNamespace(object.key, sidecarConfig)) {
				continue;
			}
			addListedResource(entries, { key: object.key, object, isCollection: isCollectionObject(object) });
		}

		for (let childPrefix of r2Objects.delimitedPrefixes ?? []) {
			let childPath = trimTrailingSlash(childPrefix);
			if (childPath === '' || isReservedWebdavNamespace(childPath, sidecarConfig)) {
				continue;
			}
			addListedResource(entries, { key: childPath, object: null, isCollection: true });
		}

		if (r2Objects.truncated) {
			cursor = r2Objects.cursor;
		}
	} while (cursor !== undefined);

	for await (let sidecarEntry of listDirectorySidecarChildren(bucket, resourcePath, sidecarConfig)) {
		if (isReservedWebdavNamespace(sidecarEntry.resourcePath, sidecarConfig)) {
			continue;
		}
		let sidecarResult = await readDirectorySidecarStateFromKey(bucket, sidecarEntry.sidecarKey);
		if (!sidecarResult.exists) {
			continue;
		}
		let sidecar = sidecarResult.sidecar;
		let existing = entries.get(sidecarEntry.resourcePath);
		if (existing?.object && existing.isCollection) {
			let directory = sidecar ?? { kind: 'directory' };
			let customMetadata = mergeDirectoryMetadata(existing.object.customMetadata, directory);
			let object = customMetadata ? ({ ...existing.object, customMetadata } as R2Object) : existing.object;
			entries.set(sidecarEntry.resourcePath, { key: sidecarEntry.resourcePath, object, isCollection: true });
			continue;
		}

		let directory = sidecar ?? { kind: 'directory' };
		let customMetadata = mergeDirectoryMetadata(undefined, directory);
		let object = customMetadata
			? createVirtualDirectoryObject(sidecarEntry.resourcePath, customMetadata, sidecarResult.uploaded)
			: null;
		addListedResource(entries, { key: sidecarEntry.resourcePath, object, isCollection: true });
	}

	for (let entry of entries.values()) {
		yield entry;
	}
}

export async function* listCollectionDescendants(
	bucket: R2Bucket,
	resourcePath: string,
	sidecarConfig: SidecarConfig = DEFAULT_SIDECAR_CONFIG,
): AsyncGenerator<ListedResource> {
	let queue = [resourcePath];
	let seen = new Set<string>();

	while (queue.length > 0) {
		let current = queue.shift();
		if (current === undefined) {
			continue;
		}
		for await (let entry of listCollectionChildren(bucket, current, sidecarConfig)) {
			if (seen.has(entry.key)) {
				continue;
			}
			seen.add(entry.key);
			yield entry;
			if (entry.isCollection) {
				queue.push(entry.key);
			}
		}
	}
}

export async function resolveResource(
	bucket: R2Bucket,
	resourcePath: string,
	sidecarConfig: SidecarConfig = DEFAULT_SIDECAR_CONFIG,
): Promise<{ object: R2Object | null; isCollection: boolean } | null> {
	if (resourcePath === '') {
		return { object: null, isCollection: true };
	}

	let resource = await bucket.head(resourcePath);
	if (resource !== null) {
		if (!isCollectionObject(resource)) {
			return { object: resource, isCollection: false };
		}

		let sidecarResult = await readDirectorySidecar(bucket, resourcePath, sidecarConfig);
		if (!sidecarResult.exists) {
			return { object: resource, isCollection: true };
		}

		let directory = sidecarResult.sidecar ?? { kind: 'directory' };
		let customMetadata = mergeDirectoryMetadata(resource.customMetadata, directory);
		let object = customMetadata ? ({ ...resource, customMetadata } as R2Object) : resource;
		return { object, isCollection: true };
	}

	let virtual = await resolveVirtualCollection(bucket, resourcePath, sidecarConfig);
	if (virtual !== null) {
		return { object: virtual, isCollection: true };
	}
	if (await hasNonInternalDescendants(bucket, resourcePath, sidecarConfig)) {
		return { object: null, isCollection: true };
	}
	if (await hasSidecarDescendants(bucket, resourcePath, sidecarConfig)) {
		return { object: null, isCollection: true };
	}

	return null;
}

export async function hasCollectionResource(bucket: R2Bucket, resourcePath: string): Promise<boolean> {
	if (resourcePath === '') {
		return true;
	}

	let resource = await bucket.head(resourcePath);
	return isCollectionObject(resource);
}

export async function hasCollectionResourceOrImplicit(
	bucket: R2Bucket,
	resourcePath: string,
	sidecarConfig: SidecarConfig = DEFAULT_SIDECAR_CONFIG,
): Promise<boolean> {
	let resolved = await resolveResource(bucket, resourcePath, sidecarConfig);
	return resolved?.isCollection ?? false;
}

type DirectoryTransferOptions = {
	deleteSource?: boolean;
	includeDescendants?: boolean;
	mapSidecar?: (sidecar: DirectorySidecar) => DirectorySidecar;
};

async function loadDirectorySidecarTransfer(
	bucket: R2Bucket,
	sourceKey: string,
	destinationKey: string,
	mapSidecar: (sidecar: DirectorySidecar) => DirectorySidecar,
): Promise<{ destinationKey: string; sourceKey: string; sidecar: DirectorySidecar } | null> {
	let source = await bucket.get(sourceKey);
	if (source === null) {
		return null;
	}
	let payload = await new Response(source.body).text();
	let parsed = parseDirectorySidecar(payload);
	if (parsed === undefined) {
		return null;
	}

	return {
		destinationKey,
		sourceKey,
		sidecar: mapSidecar(parsed),
	};
}

export async function transferDirectoryResources(
	bucket: R2Bucket,
	sourcePath: string,
	destination: string,
	mapMetadata: (object: R2Object) => Record<string, string>,
	sidecarConfig: SidecarConfig = DEFAULT_SIDECAR_CONFIG,
	options: DirectoryTransferOptions = {},
): Promise<boolean> {
	let includeDescendants = options.includeDescendants ?? true;
	let deleteSource = options.deleteSource ?? false;
	let mapSidecar = options.mapSidecar ?? ((sidecar: DirectorySidecar) => sidecar);

	let sidecarEntries: { resourcePath: string; sidecarKey: string }[] = [];
	for await (let entry of listDirectorySidecarEntries(bucket, sourcePath, sidecarConfig)) {
		sidecarEntries.push(entry);
	}
	if (!includeDescendants) {
		sidecarEntries = sidecarEntries.filter((entry) => entry.resourcePath === sourcePath);
	}

	let sidecarPaths = new Set(sidecarEntries.map((entry) => entry.resourcePath));
	let legacyMarkers: { resourcePath: string; object: R2Object; sidecar: DirectorySidecar }[] = [];
	let fileTransfers: {
		customMetadata: Record<string, string>;
		httpMetadata?: R2HTTPMetadata;
		sourceKey: string;
		targetKey: string;
	}[] = [];
	let deleteKeys: string[] = [];

	if (includeDescendants) {
		for await (let object of listAll(bucket, getCollectionPrefix(sourcePath), true)) {
			if (isCollectionObject(object)) {
				let legacy = readLegacyDirectoryMarker(object.customMetadata);
				if (legacy !== undefined) {
					legacyMarkers.push({
						resourcePath: object.key,
						object,
						sidecar: legacyMarkerToSidecar(legacy),
					});
				}
				if (deleteSource) {
					deleteKeys.push(object.key);
				}
				continue;
			}
			fileTransfers.push({
				customMetadata: mapMetadata(object),
				httpMetadata: object.httpMetadata,
				sourceKey: object.key,
				targetKey: getTransferTargetPath(destination, getCollectionPrefix(sourcePath), object.key),
			});
			if (deleteSource) {
				deleteKeys.push(object.key);
			}
		}
	}

	let rootObject = await bucket.head(sourcePath);
	if (rootObject !== null && isCollectionObject(rootObject)) {
		let legacy = readLegacyDirectoryMarker(rootObject.customMetadata);
		if (legacy !== undefined) {
			legacyMarkers.push({
				resourcePath: sourcePath,
				object: rootObject,
				sidecar: legacyMarkerToSidecar(legacy),
			});
		}
		if (deleteSource) {
			deleteKeys.push(sourcePath);
		}
	}

	let loadedFileTransfers = await Promise.all(
		fileTransfers.map(async (entry) => {
			let source = await bucket.get(entry.sourceKey);
			return source === null ? null : { entry, source };
		}),
	);
	if (loadedFileTransfers.some((entry) => entry === null)) {
		return false;
	}

	let loadedSidecarTransfers = await Promise.all(
		sidecarEntries.map((entry) =>
			loadDirectorySidecarTransfer(
				bucket,
				entry.sidecarKey,
				getDirectorySidecarKey(
					getTransferTargetDirectoryPath(sourcePath, destination, entry.resourcePath),
					sidecarConfig,
				),
				mapSidecar,
			),
		),
	);
	if (loadedSidecarTransfers.some((entry) => entry === null)) {
		return false;
	}

	let legacyTransfers = legacyMarkers
		.filter((entry) => !sidecarPaths.has(entry.resourcePath))
		.map((entry) => ({
			sidecar: mapSidecar(entry.sidecar),
			targetPath: getTransferTargetDirectoryPath(sourcePath, destination, entry.resourcePath),
		}));

	for (const loadedTransfer of loadedFileTransfers) {
		if (loadedTransfer === null) {
			return false;
		}
		await bucket.put(loadedTransfer.entry.targetKey, loadedTransfer.source.body, {
			httpMetadata: loadedTransfer.entry.httpMetadata ?? loadedTransfer.source.httpMetadata,
			customMetadata: loadedTransfer.entry.customMetadata,
		});
	}

	for (const loadedTransfer of loadedSidecarTransfers) {
		if (loadedTransfer === null) {
			return false;
		}
		await bucket.put(loadedTransfer.destinationKey, serializeDirectorySidecar(loadedTransfer.sidecar));
		if (deleteSource) {
			deleteKeys.push(loadedTransfer.sourceKey);
		}
	}

	for (const transfer of legacyTransfers) {
		await writeDirectorySidecar(bucket, transfer.targetPath, transfer.sidecar, sidecarConfig);
	}

	if (deleteSource && deleteKeys.length > 0) {
		await bucket.delete(deleteKeys);
	}

	return true;
}

export async function deleteDirectorySidecars(
	bucket: R2Bucket,
	resourcePath: string,
	sidecarConfig: SidecarConfig = DEFAULT_SIDECAR_CONFIG,
): Promise<void> {
	let keys: string[] = [];
	for await (let entry of listDirectorySidecarEntries(bucket, resourcePath, sidecarConfig)) {
		keys.push(entry.sidecarKey);
	}
	if (keys.length > 0) {
		await bucket.delete(keys);
	}
}

async function writeStoredObject(
	bucket: R2Bucket,
	sourceKey: string,
	targetKey: string,
	options: {
		customMetadata: Record<string, string>;
		httpMetadata?: R2HTTPMetadata;
		deleteSource?: boolean;
	},
): Promise<R2Object | null> {
	let source = await bucket.get(sourceKey);
	if (source === null) {
		return null;
	}

	let stored = await bucket.put(targetKey, source.body, {
		httpMetadata: options.httpMetadata ?? source.httpMetadata,
		customMetadata: options.customMetadata,
	});

	if (options.deleteSource) {
		await bucket.delete(sourceKey);
	}

	return stored;
}

export async function transferObject(
	bucket: R2Bucket,
	object: R2Object,
	target: string,
	customMetadata: Record<string, string>,
	options: { deleteSource?: boolean } = {},
): Promise<R2Object | null> {
	return writeStoredObject(bucket, object.key, target, {
		httpMetadata: object.httpMetadata,
		customMetadata,
		deleteSource: options.deleteSource,
	});
}

export async function rewriteStoredObject(
	bucket: R2Bucket,
	key: string,
	customMetadata: Record<string, string>,
	httpMetadata?: R2HTTPMetadata,
): Promise<R2Object | null> {
	return writeStoredObject(bucket, key, key, {
		httpMetadata,
		customMetadata,
	});
}

function getTransferTargetPath(destination: string, sourcePrefix: string, sourceKey: string): string {
	return joinResourcePath(destination, sourceKey.slice(sourcePrefix.length));
}

export async function transferCollectionDescendants(
	bucket: R2Bucket,
	source: R2Object,
	destination: string,
	mapMetadata: (object: R2Object) => Record<string, string>,
	options: { deleteSource?: boolean } = {},
): Promise<boolean> {
	let prefix = getCollectionPrefix(source.key);
	let transfers = [
		{
			customMetadata: mapMetadata(source),
			httpMetadata: source.httpMetadata,
			sourceKey: source.key,
			targetKey: getTransferTargetPath(destination, prefix, source.key),
		},
	];
	for await (let object of listAll(bucket, prefix, true)) {
		transfers.push({
			customMetadata: mapMetadata(object),
			httpMetadata: object.httpMetadata,
			sourceKey: object.key,
			targetKey: getTransferTargetPath(destination, prefix, object.key),
		});
	}

	let loadedTransfers = await Promise.all(
		transfers.map(async (entry) => {
			let stored = await bucket.get(entry.sourceKey);
			return stored === null ? null : { entry, stored };
		}),
	);
	if (loadedTransfers.some((entry) => entry === null)) {
		return false;
	}

	for (const loadedTransfer of loadedTransfers) {
		if (loadedTransfer === null) {
			return false;
		}
		await bucket.put(loadedTransfer.entry.targetKey, loadedTransfer.stored.body, {
			httpMetadata: loadedTransfer.entry.httpMetadata ?? loadedTransfer.stored.httpMetadata,
			customMetadata: loadedTransfer.entry.customMetadata,
		});
	}

	if (options.deleteSource) {
		await bucket.delete(transfers.map((entry) => entry.sourceKey));
	}

	return true;
}
