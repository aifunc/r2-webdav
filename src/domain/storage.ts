import { getCollectionPrefix, isCollectionObject, joinResourcePath } from './path';

export async function* listAll(bucket: R2Bucket, prefix: string, isRecursive: boolean = false) {
	let cursor: string | undefined = undefined;
	do {
		let r2Objects = await bucket.list({
			prefix,
			delimiter: isRecursive ? undefined : '/',
			cursor,
			// @ts-ignore https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2listoptions
			include: ['httpMetadata', 'customMetadata'],
		});

		for (let object of r2Objects.objects) {
			yield object;
		}

		if (r2Objects.truncated) {
			cursor = r2Objects.cursor;
		}
	} while (cursor !== undefined);
}

export async function hasCollectionResource(bucket: R2Bucket, resourcePath: string): Promise<boolean> {
	if (resourcePath === '') {
		return true;
	}

	let resource = await bucket.head(resourcePath);
	return isCollectionObject(resource);
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
): Promise<boolean> {
	let source = await bucket.get(sourceKey);
	if (source === null) {
		return false;
	}

	await bucket.put(targetKey, source.body, {
		httpMetadata: options.httpMetadata ?? source.httpMetadata,
		customMetadata: options.customMetadata,
	});

	if (options.deleteSource) {
		await bucket.delete(sourceKey);
	}

	return true;
}

export async function transferObject(
	bucket: R2Bucket,
	object: R2Object,
	target: string,
	customMetadata: Record<string, string>,
	options: { deleteSource?: boolean } = {},
): Promise<boolean> {
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
): Promise<boolean> {
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
	let transfer = (object: R2Object) =>
		transferObject(
			bucket,
			object,
			getTransferTargetPath(destination, prefix, object.key),
			mapMetadata(object),
			options,
		);

	let transfers = [transfer(source)];
	for await (let object of listAll(bucket, prefix, true)) {
		transfers.push(transfer(object));
	}
	return (await Promise.all(transfers)).every(Boolean);
}
