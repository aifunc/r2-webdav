# Project Structure Reorganization Design

**Context**

The repository had already split large WebDAV handlers, but the top-level layout still mixed multiple decomposition styles. Request orchestration, WebDAV protocol code, storage/path/lock domain logic, and shared primitives were all siblings under `src/`, which made dependency boundaries harder to understand and maintain.

**Design**

Reorganize `src/` into four explicit layers:

- `src/app/`: Worker entrypoint and method dispatch only
- `src/domain/`: reusable storage, path, auth, and lock rules
- `src/webdav/`: protocol-specific handlers, XML helpers, and response factories
- `src/shared/`: pure constants, types, and escaping utilities

Keep `src/index.ts` as the Cloudflare entry shim, forwarding to `src/app/worker.ts`. Keep `src/webdav/index.ts` as the stable internal export surface for WebDAV methods.

**Dependency Rules**

- `app -> webdav/domain/shared`
- `webdav -> domain/shared`
- `domain -> shared`
- `shared` has no upward dependencies

This intentionally moves `xml.ts` into `webdav/` instead of `shared/`, because its behavior is protocol-specific and depends on WebDAV/domain concepts.

**Expected Outcome**

The request path becomes easier to follow, domain code becomes more reusable and easier to test, and future refactors can be scoped by layer instead of touching unrelated top-level modules.
