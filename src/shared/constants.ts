export const DEFAULT_LOCK_TIMEOUT = 3600;
export const MAX_LOCK_TIMEOUT = 365 * 24 * 60 * 60;
export const DIRECTORY_SIDECAR_PREFIX = '.__webdav__/directories';
export const RESERVED_WEBDAV_PREFIX = '.__webdav__/';
export const RESERVED_WEBDAV_ROOT = RESERVED_WEBDAV_PREFIX.slice(0, -1);
export const VALID_LOCK_DEPTHS = ['0', 'infinity'] as const;
export const LOCK_METADATA_KEYS = [
	'lock_token',
	'lock_owner',
	'lock_scope',
	'lock_depth',
	'lock_timeout',
	'lock_expires_at',
	'lock_root',
	'lock_records',
];
export const INTERNAL_DELETE_FORWARD_HEADERS = ['If', 'Lock-Token'] as const;
export const RAW_XML_DAV_PROPERTIES = new Set(['resourcetype', 'supportedlock', 'lockdiscovery']);
export const DAV_NAMESPACE = 'DAV:';
export const DEAD_PROPERTY_PREFIX = 'dead_property:';
export const LOCK_RECORDS_METADATA_KEY = 'lock_records';
export const DAV_CLASS = '1, 2';
export const SUPPORT_METHODS = [
	'OPTIONS',
	'PROPFIND',
	'PROPPATCH',
	'MKCOL',
	'GET',
	'HEAD',
	'PUT',
	'DELETE',
	'COPY',
	'MOVE',
	'LOCK',
	'UNLOCK',
];
export const CORS_ALLOW_HEADERS = [
	'authorization',
	'content-type',
	'depth',
	'overwrite',
	'destination',
	'range',
	'if',
	'lock-token',
	'timeout',
];
export const CORS_EXPOSE_HEADERS = [
	'content-type',
	'content-length',
	'dav',
	'etag',
	'last-modified',
	'location',
	'date',
	'content-range',
	'lock-token',
];
