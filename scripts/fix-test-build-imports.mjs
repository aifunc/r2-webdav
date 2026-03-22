import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const BUILD_ROOT = path.resolve('.tmp/test-build');
const RELATIVE_IMPORT_PATTERN = /(?:from\s+|import\s*\()(['"])(\.\.?\/[^'"]+?)(?<!\.js)(?<!\.json)(?<!\.node)\1/g;

async function* walk(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			yield* walk(entryPath);
			continue;
		}
		yield entryPath;
	}
}

async function rewriteImports(filePath) {
	const original = await readFile(filePath, 'utf8');
	const updated = original.replace(RELATIVE_IMPORT_PATTERN, (match, quote, specifier) => {
		return match.replace(`${quote}${specifier}${quote}`, `${quote}${specifier}.js${quote}`);
	});

	if (updated !== original) {
		await writeFile(filePath, updated);
	}
}

const buildRootStat = await stat(BUILD_ROOT);
if (!buildRootStat.isDirectory()) {
	process.exit(0);
}

for await (const filePath of walk(BUILD_ROOT)) {
	if (filePath.endsWith('.js')) {
		await rewriteImports(filePath);
	}
}
