# Properties Handler Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `src/webdav/methods/properties.ts` into focused read/write modules without changing exports or WebDAV behavior.

**Architecture:** Keep `src/webdav/methods/properties.ts` as the stable re-export layer. Move shared property helpers into `property-shared.ts`, move `PROPFIND` behavior into `propfind.ts`, and move `PROPPATCH` behavior into `proppatch.ts`.

**Tech Stack:** TypeScript, Cloudflare Workers, Wrangler, Node test runner, litmus

---

### Task 1: Split the properties implementation

**Files:**

- Create: `src/webdav/methods/property-shared.ts`
- Create: `src/webdav/methods/propfind.ts`
- Create: `src/webdav/methods/proppatch.ts`
- Modify: `src/webdav/methods/properties.ts`

- [ ] Move shared property helpers into `property-shared.ts`
- [ ] Move `PROPFIND` handling into `propfind.ts`
- [ ] Move `PROPPATCH` handling into `proppatch.ts`
- [ ] Turn `properties.ts` into a stable re-export surface

### Task 2: Repair imports and keep public API stable

**Files:**

- Modify: `src/webdav/index.ts`
- Modify: `src/webdav/methods/*.ts`

- [ ] Verify all moved modules compile with correct relative imports
- [ ] Keep `handlePropfind` and `handleProppatch` exported from `src/webdav/methods/properties.ts`

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
