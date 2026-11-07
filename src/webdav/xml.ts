import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

import { getLockDetails, getLockDiscovery, getSupportedLock } from '../domain/locks';
import { getResourceHref, isCollectionObject } from '../domain/path';
import { DAV_NAMESPACE, DEAD_PROPERTY_PREFIX, RAW_XML_DAV_PROPERTIES } from '../shared/constants';
import { escapeXml } from '../shared/escape';
import type { DavProperties, DeadProperty, LockDetails, PropfindRequest, ProppatchOperation } from '../shared/types';

export { escapeXml } from '../shared/escape';

const PROPPATCH_ACTIONS = new Set<ProppatchOperation['action']>(['set', 'remove']);
const MAX_XML_NODE_COUNT = 20_000;
const MAX_XML_ELEMENT_DEPTH = 64;
const MAX_XML_ATTRIBUTE_COUNT = 5_000;
const XML_SERIALIZER = new XMLSerializer();
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

function serializeNodeChildren(node: Node): string | null {
	let xml = '';
	try {
		for (let child = node.firstChild; child !== null; child = child.nextSibling) {
			xml += XML_SERIALIZER.serializeToString(child, false, undefined, { requireWellFormed: true });
		}
	} catch {
		return null;
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
		if (!isDeadProperty(parsed)) {
			return null;
		}
		let property = parsed as DeadProperty;
		return isSafeStoredPropertyValue(property) ? property : null;
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

function hasDavNamespaceDescendant(node: Node): boolean {
	for (let child = node.firstChild; child !== null; child = child.nextSibling) {
		if (child.nodeType === child.ELEMENT_NODE) {
			let element = child as Element;
			if (element.namespaceURI === DAV_NAMESPACE || hasDavNamespaceDescendant(element)) {
				return true;
			}
		}
	}
	return false;
}

function isSafeStoredPropertyValue(property: DeadProperty): boolean {
	if (property.valueXml.trim() === '') {
		return true;
	}
	// 旧 metadata 的 valueXml 会原样拼回 PROPFIND；重新解析并拒绝 DAV 命名空间后代，
	// 防止历史数据注入 <response> 等协议层结构。默认命名空间沿用属性命名空间，
	// 以覆盖“未加前缀的子元素继承 DAV 默认命名空间”的情况。
	let namespaceDeclaration = property.namespaceURI === '' ? '' : ` xmlns="${escapeXml(property.namespaceURI)}"`;
	let document = parseXmlDocument(
		`<dead-property-value${namespaceDeclaration}>${property.valueXml}</dead-property-value>`,
	);
	if (document === null || document.documentElement === null) {
		return false;
	}
	return !hasDavNamespaceDescendant(document.documentElement);
}

function getElementProperty(element: Element): DeadProperty | null {
	if (element.prefix && (element.namespaceURI === null || element.namespaceURI === '')) {
		return null;
	}
	// dead property 的 valueXml 会以原始 XML 形式拼回 multistatus 响应；
	// 拒绝值中包含 DAV: 命名空间的后代元素，防止注入 <response> 等协议层结构（存储型 XML 注入）。
	if (hasDavNamespaceDescendant(element)) {
		return null;
	}
	let valueXml = serializeNodeChildren(element);
	if (valueXml === null) {
		return null;
	}
	return {
		namespaceURI: element.namespaceURI ?? '',
		localName: element.localName,
		prefix: element.prefix,
		valueXml,
	};
}

function isWithinXmlBudget(document: Document): boolean {
	let nodeCount = 0;
	let attributeCount = 0;
	let stack: Array<{ node: Node; depth: number }> = [{ node: document, depth: 0 }];
	while (stack.length > 0) {
		let { node, depth } = stack.pop()!;
		nodeCount += 1;
		if (nodeCount > MAX_XML_NODE_COUNT) {
			return false;
		}
		if (node.nodeType === node.ELEMENT_NODE) {
			if (depth > MAX_XML_ELEMENT_DEPTH) {
				return false;
			}
			attributeCount += (node as Element).attributes.length;
			if (attributeCount > MAX_XML_ATTRIBUTE_COUNT) {
				return false;
			}
		}
		for (let child = node.firstChild; child !== null; child = child.nextSibling) {
			stack.push({ node: child, depth: node.nodeType === node.ELEMENT_NODE ? depth + 1 : depth });
		}
	}
	return true;
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
	if (errors.length > 0 || !isWithinXmlBudget(document)) {
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
	return document.documentElement !== null && hasLocalName(document.documentElement, name);
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

function isLockElement(element: Element, name: string): boolean {
	let namespaceURI = element.namespaceURI;
	return hasLocalName(element, name) && (namespaceURI === DAV_NAMESPACE || !namespaceURI);
}

export type ParsedLockRequest = {
	scope: LockDetails['scope'];
	owner: string | undefined;
};

export function parseLockRequest(body: string): ParsedLockRequest | null {
	let document = parseXmlDocument(body);
	if (document === null || document.documentElement === null || !isLockElement(document.documentElement, 'lockinfo')) {
		return null;
	}

	let root = document.documentElement;
	let lockscope = getChildElements(root).find((child) => isLockElement(child, 'lockscope'));
	let locktype = getChildElements(root).find((child) => isLockElement(child, 'locktype'));
	if (lockscope === undefined || locktype === undefined) {
		return null;
	}
	let scopeElement = getChildElements(lockscope).find(
		(child) => isLockElement(child, 'shared') || isLockElement(child, 'exclusive'),
	);
	let writeElement = getChildElements(locktype).find((child) => isLockElement(child, 'write'));
	if (scopeElement === undefined || writeElement === undefined) {
		return null;
	}

	let ownerElement = getChildElements(root).find((child) => isLockElement(child, 'owner'));
	let owner: string | undefined;
	if (ownerElement !== undefined) {
		let serializedOwner = serializeNodeChildren(ownerElement);
		if (serializedOwner === null) {
			return null;
		}
		owner = serializedOwner.trim() || undefined;
	}
	return {
		scope: hasLocalName(scopeElement, 'shared') ? 'shared' : 'exclusive',
		owner,
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
