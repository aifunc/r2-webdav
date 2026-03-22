# HTTP Handler Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `src/webdav/http/handlers.ts` into smaller read/write-focused modules without changing exports or WebDAV behavior.

**Architecture:** Keep `src/webdav/http/handlers.ts` as the stable re-export layer. Move shared response helpers into `shared.ts`, move `GET`/`HEAD` and directory-listing logic into `content.ts`, and move `PUT`/`DELETE`/`MKCOL` into `mutations.ts`.

**Tech Stack:** TypeScript, Cloudflare Workers, Wrangler, Node test runner, litmus

---

### Task 1: Split the HTTP handler implementation

**Files:**

- Create: `src/webdav/http/shared.ts`
- Create: `src/webdav/http/content.ts`
- Create: `src/webdav/http/mutations.ts`
- Modify: `src/webdav/http/handlers.ts`

- [ ] Move shared response helpers and parent-resource validation into `shared.ts`
- [ ] Move read-path logic into `content.ts`
- [ ] Move mutation logic into `mutations.ts`
- [ ] Turn `handlers.ts` into a stable re-export surface

### Task 2: Repair imports and keep public API stable

**Files:**

- Modify: `src/app/dispatch.ts`
- Modify: `src/webdav/http/*.ts`

- [ ] Verify all moved modules compile with correct relative imports
- [ ] Keep `handleHead`, `handleGet`, `handlePut`, `handleDelete`, `handleMkcol` exported from `src/webdav/http/handlers.ts`

### Task 3: Verify no behavior drift

**Files:**

- Test: `tests/auth.test.js`
- Test: `tests/storage.test.js`
- Test: `tests/webdav-safety.test.js`

- [ ] Run `npm run test:unit`
- [ ] Run `npm run check`
- [ ] Run `npm run dev`
- [ ] Run `litmus -k http://127.0.0.1:8787/ test test`
- [ ] Confirm only local `http.expect100` still fails
