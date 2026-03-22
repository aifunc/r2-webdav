# HTTP Handler Split Design

**Context**

After the larger project-structure reorganization, `src/webdav/http/handlers.ts` remained the main oversized file inside the new layout. It still mixed read-path behavior (`GET`/`HEAD`, directory listing, range handling) with mutation behavior (`PUT`/`DELETE`/`MKCOL`), which weakened the otherwise clearer domain/protocol boundaries.

**Design**

Keep `src/webdav/http/handlers.ts` as a stable export surface, but split the implementation into focused modules:

- `src/webdav/http/shared.ts`: shared HTTP response helpers and parent-existence validation
- `src/webdav/http/content.ts`: `GET`/`HEAD`, range response headers, directory listing rendering
- `src/webdav/http/mutations.ts`: `PUT`/`DELETE`/`MKCOL`

This mirrors the existing `src/webdav/methods/` split: small focused modules plus one stable re-export entrypoint.

**Dependency Rules**

- `content.ts` and `mutations.ts` may depend on `shared.ts`, `domain/*`, and `webdav/xml.ts`
- `handlers.ts` only re-exports
- No behavior or route changes

**Expected Outcome**

The HTTP path becomes easier to scan and reason about. Read behavior and write behavior can evolve independently, while `dispatch.ts` and tests keep importing the same stable surface.
