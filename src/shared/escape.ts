const XML_ESCAPE_TABLE: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&apos;',
};

const XML_ESCAPE_PATTERN = /[&<>"']/g;

export function escapeXml(value: string): string {
	return value.replace(XML_ESCAPE_PATTERN, (character) => XML_ESCAPE_TABLE[character]);
}
