# 更新日志

## f302318（相对 877a3a3）

本提交合并了工作区此前的未提交改动与对抗式审计修复，共 23 个文件、+1434/−992。

### 安全

- **鉴权重写**：Basic 凭据解码后做 SHA-256 哈希，再以时序安全比较（`timingSafeEqual`）匹配，不再直接比较 base64 字符串；`atob` 解码带异常兜底；`AUTH_USERS` 解析结果用 `WeakMap` 缓存；支持 `USERNAME`/`PASSWORD` 单用户回退
- **防暴力破解**：401 响应前固定 1 秒延迟（`scheduler.wait(1000)`）
- **存储型 XML 注入防护**：dead property 的值中含 `DAV:` 命名空间后代元素时 PROPPATCH 返回 400，阻断向 multistatus 响应注入伪造 `<response>` 条目（审计端到端 PoC 确认后修复）
- **XML 请求体上限**：PROPFIND/PROPPATCH/LOCK body 限制 1MB（`Content-Length` 与实际读取双重检查），超限 413
- **PROPFIND 条目上限**：`PROPFIND_MAX_ENTRIES = 5000`，超限返回 507
- **锁超时时长收紧**：`MAX_LOCK_TIMEOUT` 由 1 年降为 7 天
- **CORS 统一**：`applyCorsHeaders` 统一施加，401 响应同样带 CORS 头
- **下载安全**：`Content-Disposition` 仅对可安全内联的 content type 放行（`isInlineSafeContentType`）

### 协议合规（RFC 4918）

- UNLOCK 携带未知 Lock-Token 返回 **409**（此前被 §10.4.1 正向校验误拦为 412）；`Lock-Token` 头不再作为 If 条件参与校验
- MOVE 集合携带 `Depth: 0` 按 **infinity** 处理（此前返回 400，违反 §9.8）
- 新增 §10.4.1 正向锁 token 校验：If 头提交的 token 必须对应现存锁，否则 412
- 新增 `If-Match` / `If-Unmodified-Since` 前置条件处理（含对 COPY/MOVE Destination 的校验）

### 并发与正确性

- **排他锁完整性**：修复并发首次 LOCK 隐式/legacy 集合时 `baseSidecar` 短路绕过 etag 重试重读、后写覆盖先写的问题
- LOCK / PROPPATCH / UNLOCK 的 legacy marker 清理改为 best-effort（sidecar 已是真源），不再因并发改写误报 404
- 目录 sidecar 更新使用 etag 乐观锁 + 最多 3 次重试（`updateDirectorySidecar`）；同 key 重写（`rewriteStoredObject`）用 etag 条件防 TOCTOU
- R2 list 瞬时失败自动重试

### 架构与重构

- 目录元数据（锁、dead properties）从对象 customMetadata / legacy marker 迁移到 sidecar 对象（`.__sidecar__/<path>.json`），sidecar 为真源
- 移除旧实现：`hasCollectionResource`、`transferCollectionDescendants`、`isReservedWebdavPath` 别名等
- 响应模板收敛到 `responses.ts`；GET/HEAD 集合返回 HTML 目录列表
- 路径处理：`decodeResourcePath` 折叠连续斜杠（`//foo` → `foo`），与 sidecar key 规范化口径一致

### 测试与依赖

- `tests/directory-sidecar.test.js` 扩充 219 行（含 8 个审计回归用例）；`auth.test.js` 适配异步鉴权；`storage.test.js` 精简
- lockfile 刷新，`@xmldom/xmldom` 0.8.11 → 0.8.13 等

### 验证

- `npm run test:unit`：142/142 通过
- `tsc --noEmit`、Prettier（src+tests）通过
- 经双审计者对抗式审计 + 2 轮修复审查
