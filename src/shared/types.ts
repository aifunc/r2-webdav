export interface Env {
	bucket: R2Bucket;
	USERNAME: string;
	PASSWORD: string;
}

export type DavProperties = {
	creationdate: string | undefined;
	displayname: string | undefined;
	getcontentlanguage: string | undefined;
	getcontentlength: string | undefined;
	getcontenttype: string | undefined;
	getetag: string | undefined;
	getlastmodified: string | undefined;
	resourcetype: string;
	supportedlock: string;
	lockdiscovery: string;
};

export type LockDetails = {
	token: string;
	owner: string | undefined;
	scope: 'exclusive' | 'shared';
	depth: '0' | 'infinity';
	timeout: string;
	expiresAt: number;
	root: string;
};

export type DirectorySidecarProps = Record<string, DeadProperty>;

export type DirectorySidecar = {
	kind: 'directory';
	props?: DirectorySidecarProps;
	locks?: LockDetails[];
};

export type LegacyDirectoryMarker = {
	props?: DirectorySidecarProps;
	locks?: LockDetails[];
};

export type DeadProperty = {
	namespaceURI: string;
	localName: string;
	prefix: string | null;
	valueXml: string;
};

export type PropfindRequest =
	| {
			mode: 'allprop';
	  }
	| {
			mode: 'propname';
	  }
	| {
			mode: 'prop';
			properties: DeadProperty[];
	  };

export type ProppatchOperation = {
	action: 'set' | 'remove';
	property: DeadProperty;
};
