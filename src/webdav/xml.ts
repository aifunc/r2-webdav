import { DOMParser } from '@xmldom/xmldom';

import { getLockDetails, getLockDiscovery, getSupportedLock } from '../domain/locks';
import { getResourceHref, isCollectionObject } from '../domain/path';
import { DAV_NAMESPACE, DEAD_PROPERTY_PREFIX, RAW_XML_DAV_PROPERTIES } from '../shared/constants';
import { escapeXml } from '../shared/escape';
import type { DavProperties, DeadProperty, LockDetails, PropfindRequest, ProppatchOperation } from '../shared/types';

export { escapeXml } from '../shared/escape';

const PROPPATCH_ACTIONS = new Set<ProppatchOperation['action']>(['set', 'remove']);
type DavPropertyResolver = (
	object: R2Object | null | undefined,
	context: { isCollection: boolean; resourceKey: string },
) => string | undefined;
const PROPFIND_REQUEST_RESOLVERS: Array<(document: Document) => PropfindRequest | null> = [
	(document) => (hasChildElement(document.documentElement, 'propname') ? { mode: 'propname' } : null),
	(document) => {
		let propElement = findChildElement(document.documentElement, 'prop');
		return propElement === undefined ? null : getPropfindPropertiesRequest(propElement);
	},
	(document) => (hasChildElement(document.documentElement, 'allprop') ? { mode: 'allprop' } : null),
];
const DAV_PROPERTY_RESOLVERS = {
	creationdate: (object) => object?.uploaded.toISOString(),
	displayname: (_object, context) => getDisplayName(context.resourceKey),
	getcontentlanguage: (object) => object?.httpMetadata?.contentLanguage,
	getcontentlength: (object) => (object === null || object === undefined ? '0' : object.size.toString()),
	getcontenttype: (object) => object?.httpMetadata?.contentType,
	getetag: (object) => object?.httpEtag ?? (object ? `"${object.etag}"` : undefined),
	getlastmodified: (object) => object?.uploaded.toUTCString(),
	resourcetype: (object) =>
		object === null || object === undefined ? '<collection />' : (object.customMetadata?.resourcetype ?? ''),
	supportedlock: () => getSupportedLock(),
	lockdiscovery: (object, context) =>
		object === null || object === undefined ? '' : getLockDiscoveryValue(object, context.isCollection),
} satisfies Record<keyof DavProperties, DavPropertyResolver>;

export function renderDavProperty(propName: string, value: string): string {
	let content = RAW_XML_DAV_PROPERTIES.has(propName) ? value : escapeXml(value);
	return `<${propName}>${content}</${propName}>`;
}

function getDisplayName(resourceKey: string): string | undefined {
	if (resourceKey === '') {
		return undefined;
	}
	return resourceKey.split('/').pop();
}

function serializeNodeChildren(node: Node): string {
	let xml = '';
	for (let child = node.firstChild; child !== null; child = child.nextSibling) {
		xml += child.toString();
	}
	return xml;
}

export function getDeadPropertyKey(namespaceURI: string, localName: string): string {
	return `${DEAD_PROPERTY_PREFIX}${encodeURIComponent(namespaceURI)}:${encodeURIComponent(localName)}`;
}

export function getDeadProperty(
	metadata: Record<string, string> | undefined,
	namespaceURI: string,
	localName: string,
): DeadProperty | null {
	let value = metadata?.[getDeadPropertyKey(namespaceURI, localName)];
	if (value === undefined) {
		return null;
	}
	return parseDeadProperty(value);
}

export function getDeadProperties(metadata: Record<string, string> | undefined): DeadProperty[] {
	if (metadata === undefined) {
		return [];
	}
	return Object.entries(metadata)
		.filter(([key]) => key.startsWith(DEAD_PROPERTY_PREFIX))
		.flatMap(([, value]) => {
			let property = parseDeadProperty(value);
			return property === null ? [] : [property];
		});
}

function isDeadProperty(value: Partial<DeadProperty> | null | undefined): value is DeadProperty {
	return (
		value !== null &&
		value !== undefined &&
		typeof value.namespaceURI === 'string' &&
		typeof value.localName === 'string' &&
		(value.prefix === null || typeof value.prefix === 'string') &&
		typeof value.valueXml === 'string'
	);
}

function parseDeadProperty(value: string): DeadProperty | null {
	try {
		let parsed = JSON.parse(value) as Partial<DeadProperty>;
		return isDeadProperty(parsed) ? (parsed as DeadProperty) : null;
	} catch {
		return null;
	}
}

function getQualifiedPropertyName(property: DeadProperty): string {
	return property.prefix ? `${property.prefix}:${property.localName}` : property.localName;
}

function getPropertyNamespaceDeclaration(property: DeadProperty): string {
	if (property.namespaceURI === '') {
		return ' xmlns=""';
	}
	if (property.prefix) {
		return ` xmlns:${property.prefix}="${escapeXml(property.namespaceURI)}"`;
	}
	return ` xmlns="${escapeXml(property.namespaceURI)}"`;
}

function renderPropertyXml(property: DeadProperty, valueXml: string, isEmpty: boolean = false): string {
	let qualifiedName = getQualifiedPropertyName(property);
	let namespaceDeclaration = getPropertyNamespaceDeclaration(property);
	if (isEmpty) {
		return `<${qualifiedName}${namespaceDeclaration} />`;
	}
	return `<${qualifiedName}${namespaceDeclaration}>${valueXml}</${qualifiedName}>`;
}

export function renderPropertyElement(property: DeadProperty): string {
	return renderPropertyXml(property, property.valueXml);
}

export function renderEmptyPropertyElement(property: DeadProperty): string {
	return renderPropertyXml(property, '', true);
}

function getElementProperty(element: Element): DeadProperty | null {
	if (element.prefix && (element.namespaceURI === null || element.namespaceURI === '')) {
		return null;
	}
	return {
		namespaceURI: element.namespaceURI ?? '',
		localName: element.localName,
		prefix: element.prefix,
		valueXml: serializeNodeChildren(element),
	};
}

function parseXmlDocument(body: string): Document | null {
	let errors: string[] = [];
	let document = new DOMParser({
		errorHandler: {
			warning: () => {},
			error: (message) => errors.push(message),
			fatalError: (message) => errors.push(message),
		},
	}).parseFromString(body, 'application/xml');
	if (errors.length > 0) {
		return null;
	}
	return document;
}

function getChildElements(element: Element): Element[] {
	let children: Element[] = [];
	for (let child = element.firstChild; child !== null; child = child.nextSibling) {
		if (child.nodeType === child.ELEMENT_NODE) {
			children.push(child as Element);
		}
	}
	return children;
}

function hasLocalName(element: Element, name: string): boolean {
	return element.localName.toLowerCase() === name;
}

function isDocumentElementNamed(document: Document, name: string): boolean {
	return hasLocalName(document.documentElement, name);
}

function findChildElement(element: Element, name: string): Element | undefined {
	return getChildElements(element).find((child) => hasLocalName(child, name));
}

function hasChildElement(element: Element, name: string): boolean {
	return getChildElements(element).some((child) => hasLocalName(child, name));
}

function getChildElementProperties(element: Element): DeadProperty[] | null {
	let properties = getChildElements(element).map(getElementProperty);
	return properties.some((property) => property === null) ? null : (properties as DeadProperty[]);
}

function getPropfindPropertiesRequest(propElement: Element): PropfindRequest | null {
	let properties = getChildElementProperties(propElement);
	if (properties === null) {
		return null;
	}
	return {
		mode: 'prop',
		properties,
	};
}

export function parsePropfindRequest(body: string): PropfindRequest | null {
	if (body.trim() === '') {
		return { mode: 'allprop' };
	}
	let document = parseXmlDocument(body);
	if (document === null || !isDocumentElementNamed(document, 'propfind')) {
		return null;
	}

	for (const resolveRequest of PROPFIND_REQUEST_RESOLVERS) {
		let request = resolveRequest(document);
		if (request !== null) {
			return request;
		}
	}

	return null;
}

export function parseProppatchRequest(body: string): { operations: ProppatchOperation[] } | null {
	let document = parseXmlDocument(body);
	if (document === null || !isDocumentElementNamed(document, 'propertyupdate')) {
		return null;
	}
	let operations: ProppatchOperation[] = [];
	for (const actionElement of getChildElements(document.documentElement)) {
		let action = actionElement.localName.toLowerCase() as ProppatchOperation['action'];
		if (!PROPPATCH_ACTIONS.has(action)) {
			continue;
		}
		let propElement = findChildElement(actionElement, 'prop');
		if (propElement === undefined) {
			continue;
		}
		for (const propertyElement of getChildElements(propElement)) {
			let property = getElementProperty(propertyElement);
			if (property === null) {
				return null;
			}
			operations.push({ action, property });
		}
	}
	return { operations };
}

function getLockDiscoveryValue(object: R2Object, isCollection: boolean): string {
	let lockDetails = getLockDetails(object.customMetadata);
	if (lockDetails.length === 0) {
		return '';
	}
	return getLockDiscovery(
		lockDetails.map((lockDetail: LockDetails) => ({
			...lockDetail,
			root: getResourceHref(object.key, isCollection),
		})),
	);
}

export function fromR2Object(
	object: R2Object | null | undefined,
	resourceKey: string = object?.key ?? '',
): DavProperties {
	let context = {
		isCollection: object === null || object === undefined ? true : isCollectionObject(object),
		resourceKey,
	};

	return Object.fromEntries(
		(Object.entries(DAV_PROPERTY_RESOLVERS) as [keyof DavProperties, DavPropertyResolver][]).map(
			([key, resolveValue]) => [key, resolveValue(object, context)],
		),
	) as DavProperties;
}

export function getLivePropertyValue(
	object: R2Object | null,
	property: DeadProperty,
	resourceKey: string = object?.key ?? '',
): string | undefined {
	if (property.namespaceURI !== DAV_NAMESPACE) {
		return undefined;
	}
	return fromR2Object(object, resourceKey)[property.localName as keyof DavProperties];
}

export function renderPropstat(status: string, properties: string[]): string {
	if (properties.length === 0) {
		return '';
	}
	return `
		<propstat>
			<prop>
			${properties.join('\n				')}
			</prop>
			<status>${status}</status>
		</propstat>`;
}
