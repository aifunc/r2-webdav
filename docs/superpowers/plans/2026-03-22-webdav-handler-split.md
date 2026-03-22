# WebDAV Handler Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `src/handlers/webdav.ts` into capability-focused modules while preserving behavior and public exports.

**Architecture:** Keep `src/handlers/webdav.ts` as the stable export surface and move protocol-specific logic into `shared`, `properties`, `transfer`, and `locking` modules under `src/handlers/webdav/`. Shared helpers should be centralized, and external callers should remain unchanged.

**Tech Stack:** TypeScript, Cloudflare Workers, Wrangler, Node test runner, litmus

---

### Task 1: Create target module structure

**Files:**

- Create: `src/handlers/webdav/shared.ts`
- Create: `src/handlers/webdav/properties.ts`
- Create: `src/handlers/webdav/transfer.ts`
- Create: `src/handlers/webdav/locking.ts`
- Modify: `src/handlers/webdav.ts`

- [ ] Define which shared helpers belong in `shared.ts`
- [ ] Move property handlers into `properties.ts`
- [ ] Move transfer handlers into `transfer.ts`
- [ ] Move lock handlers into `locking.ts`
- [ ] Turn `src/handlers/webdav.ts` into a stable re-export surface

### Task 2: Repair imports and keep public API stable

**Files:**

- Modify: `src/dispatch.ts`
- Modify: `src/handlers/webdav.ts`
- Modify: `src/handlers/webdav/*.ts`

- [ ] Verify all moved code imports compile with relative paths
- [ ] Keep `handlePropfind`, `handleProppatch`, `handleCopy`, `handleMove`, `handleLock`, `handleUnlock` exported from `src/handlers/webdav.ts`
- [ ] Ensure no caller needs behavior changes

### Task 3: Verify no behavior drift

**Files:**

- Test: `tests/auth.test.js`
- Test: `tests/storage.test.js`
- Test: `tests/webdav-safety.test.js`

- [ ] Run `npm run test:unit`
- [ ] Run `npm run check`
- [ ] Run `npm run dev`
- [ ] Run `litmus -k http://127.0.0.1:8787/ test test`
- [ ] Confirm only `http.expect100` still fails locally
