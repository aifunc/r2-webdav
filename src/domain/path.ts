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

export function decodeResourcePath(pathname: string): string {
	if (trimTrailingSlash(pathname.slice(1)) === '') {
		return '';
	}
	return trimTrailingSlash(pathname.slice(1))
		.split('/')
		.map((segment) => {
			try {
				return decodeURIComponent(segment);
			} catch {
				return segment;
			}
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
