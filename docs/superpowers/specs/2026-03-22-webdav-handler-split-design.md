# WebDAV Handler Split Design

## Goal

将 `src/handlers/webdav.ts` 拆分为按协议能力分组的多个模块，降低单文件复杂度，同时保持现有对外导出与行为不变。

## Scope

本次只调整 `src/handlers/webdav.ts` 的文件边界，不重构 `xml.ts`、`locks.ts`、`storage.ts` 的职责边界，不引入新的业务行为。

## Proposed Structure

- `src/handlers/webdav.ts`
  - 保留现有导出面，作为兼容入口。
- `src/handlers/webdav/shared.ts`
  - 放共享响应 helper、目标路径解析、深度处理、传输完成收口、共享类型。
- `src/handlers/webdav/properties.ts`
  - `handlePropfind`、`handleProppatch` 及其 XML 响应拼装。
- `src/handlers/webdav/transfer.ts`
  - `handleCopy`、`handleMove` 及其相关前置校验与传输流程。
- `src/handlers/webdav/locking.ts`
  - `handleLock`、`handleUnlock` 及锁请求流程。

## Constraints

- 保持 `dispatch.ts` 的调用方式不变。
- 保持现有 `test:unit`、`check`、`litmus` 结果不变。
- 共享逻辑优先收敛到 `shared.ts`，避免拆分后再次复制。

## Risks

- 拆文件时相对导入路径容易出错。
- 共享 helper 放置不当会造成模块耦合回流。

## Verification

- `npm run test:unit`
- `npm run check`
- `litmus -k http://127.0.0.1:8787/ test test`
