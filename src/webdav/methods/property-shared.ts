import { LOCK_METADATA_KEYS } from '../../shared/constants';
import type { DeadProperty } from '../../shared/types';
import { escapeXml, renderEmptyPropertyElement } from '../xml';
import { getResourceHref, isCollectionObject } from '../../domain/path';

export function isProtectedProperty(propName: string | DeadProperty): boolean {
	let localPropName = typeof propName === 'string' ? (propName.split(':').pop() ?? propName) : propName.localName;
	return (
		LOCK_METADATA_KEYS.includes(localPropName) || localPropName === 'supportedlock' || localPropName === 'lockdiscovery'
	);
}

export function renderEmptyRequestedProperty(property: DeadProperty): string {
	return renderEmptyPropertyElement({ ...property, valueXml: '' });
}

export function appendPropstatProperties(
	propstats: Map<string, string[]>,
	properties: DeadProperty[],
	status: string,
): void {
	if (properties.length === 0) {
		return;
	}

	let currentProperties = propstats.get(status) ?? [];
	currentProperties.push(...properties.map(renderEmptyRequestedProperty));
	propstats.set(status, currentProperties);
}

export function renderProppatchResponse(object: R2Object, propstats: Map<string, string[]>): string {
	let href = escapeXml(getResourceHref(object.key, isCollectionObject(object)));
	let propstatXml = Array.from(propstats.entries())
		.map(
			([status, propertyNames]) =>
				`\n\t\t<propstat>\n\t\t\t<prop>\n${propertyNames.map((propName) => `\t\t\t\t${propName}`).join('\n')}\n\t\t\t</prop>\n\t\t\t<status>${status}</status>\n\t\t</propstat>`,
		)
		.join('');

	return `<?xml version="1.0" encoding="utf-8"?>\n<multistatus xmlns="DAV:">\n\t<response>\n\t\t<href>${href}</href>${propstatXml}\n\t</response>\n</multistatus>`;
}
