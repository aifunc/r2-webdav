import { DEFAULT_SIDECAR_CONFIG, getSidecarPrefix } from '../shared/sidecar';
import type { SidecarConfig } from '../shared/types';

export function trimTrailingSlash(path: string): string {
	if (path.endsWith('/')) {
		return path.slice(0, -1);
	}
	return path;
}

function encodeHrefPath(path: string): string {
	if (path === '/') {
		return '/';
	}
	// 首段恒为空串（来自前导 `/`），故跳过；其余段逐个编码。
	return path
		.split('/')
		.map((segment, index) => (index === 0 ? segment : encodeURIComponent(segment)))
		.join('/');
}

export function getResourceHref(key: string, isCollection: boolean): string {
	if (key === '') {
		return '/';
	}
	return encodeHrefPath(`/${key + (isCollection ? '/' : '')}`);
}

export class InvalidResourcePathError extends Error {}

export function decodeResourcePath(pathname: string): string {
	// WHATWG URL 会规范化 `..` 但不折叠连续斜杠；统一折叠，
	// 避免 `//foo` 产生带前导斜杠的 resourcePath（与 sidecar key 口径不一致）。
	let normalized = pathname.replace(/\/{2,}/g, '/');
	if (trimTrailingSlash(normalized.slice(1)) === '') {
		return '';
	}
	return trimTrailingSlash(normalized.slice(1))
		.split('/')
		.map((segment) => {
			let decoded: string;
			try {
				decoded = decodeURIComponent(segment);
			} catch {
				decoded = segment;
			}
			// 解码后重新引入分隔符会绕过分段检查，并与字面路径指向同一存储/元数据：
			// 例如 `/%2Fdocs` 与 `/docs` 都归一为 `docs`。拒绝而不是静默合并。
			if (decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) {
				throw new InvalidResourcePathError('resource path segment contains a separator');
			}
			return decoded;
		})
		.join('/');
}

export function getParentPath(resourcePath: string): string {
	return trimTrailingSlash(resourcePath).split('/').slice(0, -1).join('/');
}

export function getAncestorPaths(resourcePath: string): string[] {
	let ancestors: string[] = [];
	for (let current = resourcePath; ; current = getParentPath(current)) {
		ancestors.push(current);
		if (current === '') {
			return ancestors;
		}
	}
}

export function getCollectionPrefix(resourcePath: string): string {
	return resourcePath === '' ? '' : `${resourcePath}/`;
}

export function hasTrailingSlashPath(request: Request): boolean {
	return new URL(request.url).pathname.endsWith('/');
}

export function joinResourcePath(basePath: string, relativePath: string): string {
	return trimTrailingSlash(`${basePath}/${relativePath}`);
}

export function isReservedWebdavNamespace(
	resourcePath: string,
	sidecarConfig: SidecarConfig = DEFAULT_SIDECAR_CONFIG,
): boolean {
	let sidecarPrefix = getSidecarPrefix(sidecarConfig);
	return resourcePath === sidecarPrefix || resourcePath.startsWith(`${sidecarPrefix}/`);
}

export function isCollectionResourceType(resourceType: string | undefined): boolean {
	return resourceType === '<collection />';
}

export function isCollectionObject(object: { customMetadata?: Record<string, string> } | null | undefined): boolean {
	return isCollectionResourceType(object?.customMetadata?.resourcetype);
}

export function parseDestinationPath(destinationHeader: string, requestUrl: string): string | null {
	try {
		let destinationUrl = new URL(destinationHeader, requestUrl);
		if (destinationUrl.origin !== new URL(requestUrl).origin) {
			return null;
		}
		return decodeResourcePath(destinationUrl.pathname);
	} catch {
		return null;
	}
}

export function isSameOrDescendantPath(resourcePath: string, destinationPath: string): boolean {
	if (destinationPath === resourcePath) {
		return true;
	}
	if (resourcePath === '') {
		return destinationPath !== '';
	}
	return destinationPath.startsWith(`${resourcePath}/`);
}

export function hasConflictingCollectionDestination(resourcePath: string, destinationPath: string): boolean {
	return isSameOrDescendantPath(resourcePath, destinationPath) || isSameOrDescendantPath(destinationPath, resourcePath);
}

export function makeResourcePath(request: Request): string {
	return decodeResourcePath(new URL(request.url).pathname);
}
