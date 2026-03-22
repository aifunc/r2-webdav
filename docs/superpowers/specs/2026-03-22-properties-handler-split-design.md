# Properties Handler Split Design

**Context**

`src/webdav/methods/properties.ts` is now the largest remaining protocol file. It mixes `PROPFIND` read-path behavior, `PROPPATCH` mutation behavior, XML response construction, and property protection rules in one place.

**Design**

Keep `src/webdav/methods/properties.ts` as the stable export surface, but split the implementation into focused modules:

- `src/webdav/methods/property-shared.ts`: shared helpers for protected-property checks and shared XML fragments
- `src/webdav/methods/propfind.ts`: `PROPFIND` request handling and multistatus response assembly
- `src/webdav/methods/proppatch.ts`: `PROPPATCH` request handling and propstat response assembly

This follows the same pattern already used for `webdav/http` and keeps protocol reads and writes separate while preserving imports from `src/webdav/index.ts`.

**Dependency Rules**

- `propfind.ts` and `proppatch.ts` may depend on `property-shared.ts`, `domain/*`, `shared/*`, `webdav/xml.ts`, and `webdav/responses.ts`
- `properties.ts` only re-exports
- No behavior or response changes

**Expected Outcome**

The remaining WebDAV property code becomes easier to scan, review, and extend. `PROPFIND` depth traversal and `PROPPATCH` mutation logic can evolve independently without reintroducing a large mixed-responsibility file.
