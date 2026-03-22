# Project Structure Reorganization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize the codebase into clearer `app`, `domain`, `webdav`, and `shared` layers without changing runtime behavior.

**Architecture:** Keep the Worker entry shim stable at `src/index.ts`, move orchestration into `src/app/`, move reusable rules into `src/domain/`, move protocol code into `src/webdav/`, and keep only pure primitives in `src/shared/`. Preserve existing tests and WebDAV behavior while updating imports and docs.

**Tech Stack:** TypeScript, Cloudflare Workers, Wrangler, Node test runner, litmus

---

### Task 1: Establish the new layout

**Files:**

- Create: `src/app/worker.ts`
- Modify: `src/index.ts`
- Move/Modify: `src/app/*`, `src/domain/*`, `src/shared/*`, `src/webdav/*`

- [ ] Create the new layered directories
- [ ] Move existing modules into the matching layer
- [ ] Add a thin Worker shim at `src/index.ts`
- [ ] Keep `src/webdav/index.ts` as the stable WebDAV export surface

### Task 2: Repair imports and references

**Files:**

- Modify: `src/**/*.ts`
- Modify: `tests/*.js`
- Modify: `README.md`
- Modify: `AGENTS.md`

- [ ] Update all relative imports to match the new layout
- [ ] Update tests to reference the new module locations
- [ ] Refresh documentation to describe the new structure accurately

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
