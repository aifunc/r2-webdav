# r2-webdav 安全与缺陷审计：2026-11-07

审计基线：`02a524e85eeb664f94801a789fd5f71ba347fb5b`，当前工作区 `main`。日期为 **2026-11-07，Asia/Shanghai**。审查了全部 `src/`、现有测试、依赖锁文件、Wrangler 配置，以及本地开发、迁移和 CI 文件。初版报告交付时业务代码未修改；随后按用户要求完成修复。A01–A11 与回归测试已提交为 `4a85eff`；Wrangler 4.158.0 依赖升级已提交为 `423fac2`；A05/A06 的按资源分片守卫扩展已提交为 `1852b1a`；A05/A06 的 Durable Object 协调器与 3 条 DO 测试已提交为 `06ebf61`；缺失 DO binding 时 fail-closed、XML 解析预算与对应测试已提交为 `f9d6051`。未部署、未迁移。新增的回归测试与本地验证材料见下文“修复实施状态”。

**结论：初版审计复现了数据丢失、条件请求失效和锁一致性缺陷；线上唯一第三方 XML 依赖曾命中公开安全公告，开发工具链亦有公告命中。修复后 A01–A04、A06–A11 已在本工作树修复并有回归覆盖；A05 的并发 LOCK 与跨方法写操作由单实例 Durable Object 的 shared/exclusive 层级守卫串行化，根路径 LOCK 也会阻止子资源写入，目录 sidecar 与文件锁不再出现并发双成功；A12 已通过 Wrangler 4.158.0 升级消除 npm 命中，但 Miniflare 5 beta 仍是兼容性风险。未发现明确的源码后门迹象。Durable Object 是应用层协调，不是 R2 存储级事务。**

**网络恢复后的补核已完成：** 已直接读取 GitHub/OSV 官方公告、npm 发布信息、Cloudflare 文档、Node.js 支持周期及 RFC 原文，补全 xmldom 的 CVE、日期、修复版本和默认/可选防护差异，并新增 A12 开发工具链公告命中。修复前最新只读 npm audit 返回 **5 个 high 受影响包条目、36 条独立 GHSA**；将 xmldom 升到 0.8.15 后为 **4 个 high 受影响包条目、26 条独立 GHSA（Undici 23 + sharp 3）**。进一步升级到 Wrangler **4.158.0**（Miniflare 5.20261104.0-beta、Undici 7.30.1、sharp 0.35.5）后，隔离 `npm audit` 为 **exit 0、0 条**。升级前 Wrangler/Miniflare 是依赖风险传导条目，不是额外的独立公告。依赖链、完整来源与适用性见 [依赖与供应链研究报告](security-dependency-research-2026-11-07.md)、[xmldom 公告补核](security-xmldom-verification-2026-11-07.md) 和 [Cloudflare 开发链补核](security-cloudflare-verification-2026-11-07.md)。托管实例的实际补丁状态仍不能从本地版本推定。

## 范围与攻击前提

- 普通方法在 `src/app/worker.ts:24` 先检查 Basic 鉴权；未配置有效账号时拒绝访问。`OPTIONS` 无需认证，但不会进入 XML 解析或数据修改。此次未复现匿名鉴权绕过。
- 以下 XML、写入、锁和内容上传问题均要求**有效 WebDAV 凭据或已被盗用的账号**。浏览器内容问题还要求有人打开上传内容。数据一致性问题也可由正常客户端的错误重试、并发同步或特殊文件名触发。
- `AUTH_USERS` 配置的是共享同一 bucket 的多个账号，代码不区分用户身份或用户目录权限。它不能作为租户隔离机制；这里没有把这种设计本身列为越权漏洞。
- 所有重现均使用内存模型或独立本地 Miniflare R2，不访问生产 R2，不使用真实应用凭据。初版审计没有执行部署、迁移、依赖安装或自动修复；后续修复实施只在本地安装了 xmldom 0.8.15，并在本地安装了 Wrangler 4.158.0；未部署、未迁移。
- 未跟踪的 `.agents/`、`.forge/`、`.serena/` 和 `bimtail.dmg` 不属于已跟踪应用源码；未运行或挂载该镜像，没有对其二进制内容逆向，不能据此保证它无恶意内容。

## 发现概览

这里的等级反映本项目的触发条件与影响，和 npm 公告的原始级别分别记录。WebDAV 锁是并发控制机制，以下“锁绕过”不等于绕过账号鉴权。

| 编号 | 等级                     | 问题                                                                                        | 主要证据位置                                                                                      | 证据强度                                                                          |
| ---- | ------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| A01  | 高                       | 线上 xmldom 命中解析复杂度等安全公告                                                        | `package-lock.json:1220`；`src/webdav/xml.ts:169`                                                 | 在线 npm audit、代码可达性、受控性能验证                                          |
| A02  | 高                       | 无效 Depth 的 COPY/MOVE 先删除目标再返回 400                                                | `src/webdav/methods/transfer.ts:76`、`:199`                                                       | 内存重现；COPY 在本地 R2 再确认                                                   |
| A03  | 中                       | 编码斜杠造成资源名与 sidecar 名不一致，自移动检查可被绕过                                   | `src/domain/path.ts:29`；`src/domain/directories.ts:20`                                           | 鉴权入口重现、本地 R2 再确认                                                      |
| A04  | 中                       | 集合 MOVE 与新建无限深度锁缺少子树锁冲突检查                                                | `src/webdav/methods/transfer.ts:154`；`src/webdav/methods/locking.ts:71`                          | 文件锁、目录 sidecar 锁及原锁持有人操作均重现                                     |
| A05  | 中                       | 文件与首次目录排他锁都存在并发覆盖                                                          | `src/domain/storage.ts:648`；`src/domain/directories.ts:206`                                      | 确定性交错重现；文件问题在本地 R2 再确认                                          |
| A06  | 中                       | DELETE/PROPPATCH 忽略 If-Match，WebDAV If 的假条件也可被忽略                                | `src/webdav/http/mutations.ts:109`；`src/domain/locks.ts:503`                                     | 鉴权入口重现；DELETE 在本地 R2 再确认                                             |
| A07  | 中，取决于浏览器使用方式 | SVG/显式 inline HTML 可作为同源活动内容返回                                                 | `src/webdav/http/content.ts:28`、`:65`                                                            | PUT→GET 内容和响应头已验证；未运行浏览器                                          |
| A08  | 中，工程与发布可靠性     | 关键脚本/CI 未跟踪，本地 CI Node 版本也不兼容                                               | `package.json:7`、`:9`；本地 workflow `:28`                                                       | Git 索引、忽略规则、工具启动代码                                                  |
| A09  | 低                       | 目录 PROPPATCH 打乱 remove/set 顺序并丢失最终属性                                           | `src/webdav/methods/proppatch.ts:124`                                                             | 重现 207 成功但属性丢失                                                           |
| A10  | 中，协议兼容性           | LOCK 正则解析拒绝标准命名空间前缀                                                           | `src/webdav/methods/locking.ts:65`                                                                | 标准 `D:write` 请求返回 400                                                       |
| A11  | 低                       | 无根元素 XML 触发未捕获异常                                                                 | `src/webdav/xml.ts:192`                                                                           | 两种请求体、两个解析入口均重现                                                    |
| A12  | 中，开发链与供应链       | 升级前开发工具链精确版本命中 26 条公告；升级后 npm audit 为 0；bundle 另有未列入 npm 的组件 | `package-lock.json:1373`、`:1434`、`:1519`、`:1560`；`node_modules/wrangler/wrangler-dist/cli.js` | 官方 OSV/GitHub 精确版本查询、升级后隔离审计、bundle 内嵌版本读取、可达性边界分析 |

## 修复实施状态（2026-11-07）

以下状态对应当前工作树，不是已发布版本。修复目标来自初版发现；没有执行部署、迁移或远程 R2 操作。

| 编号 | 状态                  | 实施与验证                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01  | 已修复                | `@xmldom/xmldom` 升到 **0.8.15** 并更新锁文件，且启用 `requireWellFormed: true` 序列化校验，并加入 XML 节点数/深度/属性数预算；未采用会破坏对象形式 `errorHandler` 的 0.9.12。修复后 npm audit 不再列出 xmldom。                                                                                                                                                                                                                                                    |
| A02  | 已修复                | 统一 `normalizeDepthHeader`/`parseOverwriteHeader`；在删除目标前校验 Depth 和 Overwrite，集合只接受 0/infinity，无效值返回 400 且目标保留。                                                                                                                                                                                                                                                                                                                         |
| A03  | 已修复                | `decodeResourcePath` 对解码后 segment 含 `/`、`\`、NUL 抛 `InvalidResourcePathError`，入口返回 400，避免 sidecar 别名和自移动绕过。                                                                                                                                                                                                                                                                                                                                 |
| A04  | 已修复                | MOVE 源检查改用递归锁检查；新建 depth infinity 锁先检查后代锁，冲突返回 423；shared 请求只与后代 exclusive 锁冲突。                                                                                                                                                                                                                                                                                                                                                 |
| A05  | 已修复（DO 协调）     | 目录 sidecar 首次写用 `etagDoesNotMatch:'*'` 条件创建；新增单实例 `MutationGuardDurableObject` 层级守卫：目标取 exclusive，祖先（含根路径）取 shared，LOCK/UNLOCK 与 dispatch 的 PUT/DELETE/MKCOL/PROPPATCH/COPY/MOVE 共用。同资源/父子资源冲突返回 423，不同资源可并行；守卫按 token 分键、120 秒 lease、30 秒心跳续期，单请求路径预算 32 KiB、活动 token/条目上限 256/4096；Worker 层缺少 binding 时写请求返回 503，只有直接调用 handler 的测试使用 R2 CAS 回退。 |
| A06  | 已修复（DO + 条件）   | DELETE/PROPPATCH 增加 `If-Match`；`If` 条件列表整体求值，假条件在修改前返回 412；dispatch 的 DO 层级守卫使应用层请求的条件检查与写入不再交错。R2 无条件 delete，带外写入仍是边界。                                                                                                                                                                                                                                                                                  |
| A07  | 已修复（缓解）        | HTML/XHTML/SVG/XML/JS 等活动类型强制 `Content-Disposition: attachment`，覆盖上传的 inline，并加 `X-Content-Type-Options: nosniff` 与 `CSP: sandbox`。                                                                                                                                                                                                                                                                                                               |
| A08  | 已修复并提交          | `.gitignore` 不再忽略 `.github/`、`scripts/`、`.gitignore`；workflow Node 20→22。随 `4a85eff` 进入版本库，远端 CI 仍需实际 push 后验证。                                                                                                                                                                                                                                                                                                                            |
| A09  | 已修复                | 目录 PROPPATCH 按解析后的 operations 顺序执行 set/remove，不再统一先 set 后 remove。                                                                                                                                                                                                                                                                                                                                                                                |
| A10  | 已修复                | LOCK 使用命名空间感知的 `parseLockRequest`，标准 `D:write`/prefixed XML 可解析；Depth 大小写不敏感。                                                                                                                                                                                                                                                                                                                                                                |
| A11  | 已修复                | `isDocumentElementNamed` 检查 `documentElement !== null`，无根 XML 由入口作为无效请求处理，不再抛未捕获异常。                                                                                                                                                                                                                                                                                                                                                       |
| A12  | 已修复（升级后 0 条） | Wrangler 升至 **4.158.0**，带入 Miniflare 5.20261104.0-beta、Undici 7.30.1、sharp 0.35.5；隔离 audit 0。unit/typecheck/clean `npm ci`/dev smoke 通过；Miniflare 5 beta 兼容性仍属残余风险，未跑 litmus。                                                                                                                                                                                                                                                            |

验证结果：`npm run test:unit` **183/183 通过**（新增 41 条安全回归），`npx tsc --noEmit` 通过；对修改的源码、测试、配置和四份文档执行 Prettier check 通过。修复后复现脚本确认大小写、无效 Depth 保留目标、MOVE 子树锁、并发文件/目录锁、If/If-Match、prefixed LOCK、rootless XML、PROPPATCH 顺序、SVG/HTML 附件化等行为均已改变；并发文件锁与主要变更方法由 Durable Object 守卫串行化，本地 dev 已验证根路径 LOCK 对子资源 PUT 返回 423、并发文件 LOCK 为一个 201 加一个 423；新增回归还覆盖缺失 DO binding 时写请求 503，以及超深 XML 被拒绝。绕开 dispatch 的路径仍按上表保留边界。

## 重新审计：修复引入的回归（2026-11-07）

在修复提交后对 `02a524e..HEAD` 做第二轮审查，重点检查新增的条件求值与 DO 守卫是否改变合法请求行为。确认并修复了 **1 个由 A06 引入的回归**：

- **内部 DELETE 继承源 ETag**：COPY 覆盖集合、MOVE 覆盖文件时，`transfer.ts` 会先对目标调用 `handleDelete`，并转发源请求头。原实现把 `If` 原样转发；A06 的 `evaluateIfHeaderConditions` 在内部 DELETE 中按目标 URL 求值，源 ETag 被拿去匹配目标 ETag，导致带有效源 `If` 的 COPY collection / MOVE file 返回 412（应为 204）。
- **修复**：新增 `buildInternalDeleteIfHeader(ifHeader, requestUrl, targetPath)`。无标签列表只保留正向锁 token（源 ETag 已由外层校验）；标签指向目标或目标后代的列表原样保留，使目标 ETag、后代锁 token 继续生效；`buildForwardedDeleteHeaders` 使用过滤后的 `If`，并继续转发 `Lock-Token`。
- **回归覆盖**：`COPY collection evaluates If conditions against the source when overwriting`、`MOVE evaluates If conditions against the source when overwriting`、`internal DELETE forwards only lock tokens from If`、`internal DELETE preserves target-tagged If conditions`。复测 **183/183** 通过，`tsc`/Prettier 通过。

本轮确认的 A06 回归已修复；随后继续修复了上一轮列出的可修残余：

- **`DAV:no-lock`**：`evaluateIfHeaderConditions` 现在用 `hasAnyLockForPath` 读取目标的有效锁状态；未锁资源上 `<DAV:no-lock>` 为真、`Not <DAV:no-lock>` 为假，有锁时相反。正向 `DAV:no-lock` 不再被当作无效 token 提交。
- **LOCK 命名空间兼容**：`parseLockRequest` 接受 DAV 命名空间或未限定命名空间；其他命名空间仍拒绝，保留结构校验。
- **旧 dead property**：`parseDeadProperty` 重新解析 `valueXml`（沿用属性的默认命名空间）并拒绝 DAV 命名空间后代，旧 metadata 不能再注入 `<response>` 等协议结构；无法解析的旧值会被忽略。
- **相对 Destination**：内部 DELETE 现在使用 `new URL(destinationTarget.header, request.url)`，相对目标不再抛未捕获异常。
- **目标父目录预创建条目不成立**：`ensureDestinationParentExists` 和 `ensureParentCollectionResource` 只检查、不创建父目录；上一版报告误写为“创建”，已从残余表移除。

仍存在的边界：

| 项目          | 性质       | 说明                                                                                                                                                                                                                                                        |
| ------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DO 租约与容量 | 新架构残余 | 守卫已改为按 token 分键记录，单请求最多 1024 条路径、路径字符预算 32 KiB、活动 token 上限 256、条目上限 4096；每 30 秒心跳续期。仍存在的边界是单实例全局串行、认证用户可占满全局容量导致 503、DO 驱逐或连续续期失败后旧持有者可能继续写，以及没有 fencing。 |
| R2 带外写入   | 架构边界   | R2 公开 API 无条件 delete，DO 只协调经 Worker 的请求；直接改 bucket 的写入不受保护。                                                                                                                                                                        |

结论：修复没有引入新的高/中危可利用路径；A06 条件回归、`DAV:no-lock`、LOCK 命名空间兼容、旧 dead property 值和相对 Destination 已修复并有回归覆盖；DO 容量上限与续期已实现，剩余单实例吞吐、续期失败后的旧持有者和 R2 带外写入边界。
`package.json` 初版声明 `@xmldom/xmldom: ^0.8.11`，当时实际锁定并安装的是 **0.8.13**；现已升到 **0.8.15**。已逐条取回完整官方公告并交叉检查精确版本查询：0.8.13 命中 **10 条 GHSA（npm 分级为 8 high、2 moderate）**。初次只读 npm audit 只返回这一个包；网络恢复后的两次独立审计均返回 5 个受影响包条目、36 条独立 GHSA，其他 26 条来自开发链，见 A12。这不是十个 xmldom 漏洞包，也不是十个全部已证实可利用的应用漏洞。

其中以下公告的受影响范围均为 `>=0.7.0 <=0.8.14`，覆盖实际版本，并与当前解析调用路径相符：

- [GHSA-8344-3jmq-59r6](https://github.com/advisories/GHSA-8344-3jmq-59r6)：属性去重的二次时间复杂度。
- [GHSA-x4fp-j954-r2f4](https://github.com/advisories/GHSA-x4fp-j954-r2f4)：结束标签空白处理正则的二次回溯。
- [GHSA-965w-775f-mr7g](https://github.com/advisories/GHSA-965w-775f-mr7g)：二次内存消耗。
- [GHSA-93r5-fhx6-vmg9](https://github.com/advisories/GHSA-93r5-fhx6-vmg9)：错误恢复与文本合并的二次解析成本。

`PROPFIND` 在 `methods/propfind.ts:146` / `:150`，`PROPPATCH` 在 `methods/proppatch.ts:49` / `:53`，均进入 `xml.ts:169` 的 DOMParser。解析是同步的；应用积累错误并等到解析结束后才拒绝请求。1 MiB 的流式大小限制有效，但不限制属性数、深度、命名空间数或解析总操作量。`LOCK` 现在走 `parseLockRequest` 的命名空间感知 XML 解析，同样进入该 DOMParser 入口。

使用实际应用的 `parsePropfindRequest` 对合法、扁平 XML 做了受控测量；每档三次取中位数，Node v24.22.2，进程堆上限 128 MiB，最大输入小于 160 KiB：

| 属性数 | 请求体 bytes | 解析耗时中位数 ms |
| ------ | ------------ | ----------------- |
| 1,000  | 7,934        | 2.20              |
| 2,000  | 16,934       | 6.10              |
| 4,000  | 34,934       | 18.99             |
| 8,000  | 70,934       | 85.31             |
| 16,000 | 148,934      | 225.79            |

这是本机超线性成本的实测支持，不能直接换算成生产 Worker CPU 限额、全站影响范围或服务耗尽阈值。没有对线上服务做 DoS 实验。其他涉及 `createElement`、`setAttribute`、EntityReference 等 API 的公告，没有因为版本命中就一概判为应用可利用。

关于其余 6 条：`GHSA-6h8r-xr42-gp59` 的维护者已在仓库公告中加入 2026-10-09 WARNING，按后来制定的安全策略将其视为 **Hardening**，称解析后的 DOM 与良构输入相同且尚无可信利用方式；原描述、评分和补丁未改，CVE 也未撤回，全局数据库仍是旧描述。因此这 10 条是版本命中数，不是 10 个已证明的应用漏洞；4 条解析复杂度问题仍应与该条区分对待。

**已核实的修复目标：** 当前 0.8 分支应至少更新到已发布的 **[0.8.15](https://github.com/xmldom/xmldom/releases/tag/0.8.15)**，`0.8.14` 仍在多条受影响范围内。0.9 分支对应 **0.9.12**，但不能直接替换：该版本的 [DOMParser 源码](https://raw.githubusercontent.com/xmldom/xmldom/0.9.12/lib/dom-parser.js) 对当前应用正在使用的对象形式 `errorHandler` 抛出 `errorHandler object is no longer supported, switch to onError!`，需要迁移错误回调和异常处理。

**序列化防护已启用：** `src/webdav/xml.ts` 的 `serializeNodeChildren` 现在通过 `XMLSerializer.serializeToString(child, false, undefined, { requireWellFormed: true })` 序列化；遇到非法 PI target、DocType name 或其他不合规节点时返回 `null`，PROPPATCH/LOCK 解析随即将请求判为无效，而不是把原始节点拼回响应。回归覆盖 `<?xml?>` 非法 PI 被拒绝、合法 `<?xml-stylesheet?>` 仍可通过。**修复状态：** 已升级到 0.8.15、更新锁文件并启用该选项；0.9.12 因对象形式 `errorHandler` 兼容问题未采用。解析后的结构预算已加入 `src/webdav/xml.ts`：最多 20,000 个节点、元素嵌套深度 64、属性总数 5,000；超限请求按无效 XML 拒绝。该限制发生在解析之后，不能替代解析器自身的复杂度修复，但可阻止超大结构进入后续遍历/序列化。旧 metadata 的 dead property 在读取时也会重新解析 `valueXml` 并拒绝 DAV 命名空间后代；但这仍不等于已证明所有历史属性名/值组合都安全，不能替代对旧数据的迁移清洗。

### 协议兼容性修复（生产排查，2026-11-07）

用 Bettbox（Dart `webdav_client` 1.2.2）连接生产实例时，客户端在 `OPTIONS` 之后直接失败，未发出 PUT。检查客户端源码确认它在 `wdWriteWithBytes` / `wdReadWithBytes` / `ping` 中要求 `OPTIONS` 返回 **200**，而本服务返回 **204**；同时发现两个独立的协议正确性问题：

- `src/app/dispatch.ts` 的 `optionsResponse()` 改为 **200** + `Content-Length: 0`（RFC 9110 §9.3.7 的常规形态），CORS 预检仍返回 2xx 和原有 CORS 头；
- 仅由目录 sidecar 合成的集合对象没有 `etag`，PROPFIND 曾因此输出 `<getetag>"undefined"</getetag>`；`src/webdav/xml.ts` 的 `getetag` 现在只在 `etag` 为字符串时输出，合成集合不再伪造 ETag；
- `src/webdav/http/content.ts` 在客户端未发送 `Range` 时也会因为 R2 返回 `object.range` 而回 **206**；现在只有请求带 `Range` 才返回 206/`Content-Range`，完整下载恢复为 **200**。

本地 dev 复测：`OPTIONS /` 200、`MKCOL /Bettbox/` 201/405、PROPFIND 无 `undefined`、PUT 201、无 Range 的 GET 200 且字节一致、带 Range 的 GET 206。该问题与安全边界无关，但会阻断严格客户端的上传与恢复。

## A02：参数错误也会永久删除目标数据

`handleCopy` 在 `transfer.ts:76` 开始删除已有目标集合，直到 `:95` 才校验 Depth；`handleMove` 对应为 `:199` 先删除，`:237` 后校验。

重现前置为 `source/a.txt` 和 `target/important.txt` 都存在。发送集合 `COPY /source/` 或 `MOVE /source/`，头为 `Destination: https://audit.test/target/`、`Depth: 1`。**两个方法都返回 400，目标文件及目标 sidecar 已被删除，源文件仍在。** 客户端看到失败响应时可能不会意识到已有数据已经消失。COPY 已进一步使用本地 Miniflare R2 确认。

即使 Depth 合法，先删除已有目标再尝试读取/写入源也没有保留旧目标的恢复能力；后续传输失败时，`storage.ts:611` 的回滚只清除新写目标，不恢复原目标。错误参数导致的删除不需要模拟 R2 故障即可复现。

**规范补核：** [RFC 4918 §9.8.3](https://www.rfc-editor.org/rfc/rfc4918.html#section-9.8.3) 只允许集合 COPY 的 Depth 为 0/infinity，[§9.9.2](https://www.rfc-editor.org/rfc/rfc4918.html#section-9.9.2) 要求集合 MOVE 的 Depth 为 infinity。同时 [§9.8.4](https://www.rfc-editor.org/rfc/rfc4918.html#section-9.8.4) / [§9.9.3](https://www.rfc-editor.org/rfc/rfc4918.html#section-9.9.3) 允许或要求覆盖前处理旧目标的删除，不能把“先删除再复制”本身或缺少整个集合的原子回滚一概描述为违反 RFC。这里已复现的确定缺陷是无效参数被拒绝前已发生删除；暂存、备份和恢复属于可靠性改进建议。

**建议：** 在任何修改前完成 Depth、目标、锁和条件头校验。覆盖已有目标时先准备可完成的传输，并采用暂存/备份和补偿恢复策略，避免失败请求直接破坏旧目标。为无效 Depth 和中途读写失败补充“目标内容保持完整”的回归用例。

## A03：编码斜杠使集合自移动检查失效

`path.ts:29` 在解码前折叠字面斜杠，随后逐段 `decodeURIComponent`，因此 `/%2Fdocs/` 产生资源路径 `/docs`，普通 `/docs/` 产生 `docs`。但 `directories.ts:20` 为 sidecar 生成 key 时又去掉首尾斜杠，两个路径都映射到 `.__sidecar__/docs.json`。冲突检查和 R2 文件 key 却继续把它们当作不同路径。

在 `docs/file.txt` 与 `.__sidecar__/docs.json` 存在时，发送 `MOVE /docs/`，目标为 `https://audit.test/%2Fdocs/`。结果为 **204**：源文件被移至 `/docs/file.txt`，共享的 sidecar 被源清理阶段删除，根目录列表不再显示该目录。文件字节还可通过特殊路径直接访问；这里没有把“从列表消失”误写成所有文件内容都永久丢失。目录的 sidecar 属性/时间戳等则可能真正丢失。已在本地 R2 再确认。

**建议：** 为请求路径、Destination、If 的 tagged URI、sidecar 和 R2 key 采用同一套严格资源命名规则。对编码路径分隔符、解码后空段等产生歧义的输入在读写前拒绝，或明确建立一一对应编码；不要仅在某一处额外 trim。增加自移动、祖先/后代、保留空间和带编码斜杠的矩阵回归。

## A04：对子树现有锁检查不完整

两条独立操作路径存在同一层级冲突遗漏：

1. **集合 MOVE：** `transfer.ts:154` 只调用 `assertLockPermission` 检查根和祖先，随后 `storage.ts:617` 删除所有源后代。对 `docs/child.txt` 的排他文件锁或 `docs/sub/` 的目录 sidecar 锁，`DELETE /docs/` 正确返回 423；但不带任何 token 的 `MOVE /docs/ → /moved/` 返回 201，源后代已被删除/移动。
2. **新建 Depth:infinity 排他锁：** `locking.ts:71` 和 `:147` 只检查目标及祖先。已有排他子文件锁时，其他客户端仍可对 `docs/` 创建无限深度排他锁并得到 201。原子文件锁持有人只提交自己的有效 token 再 PROPPATCH 子文件时变成 423，被后来建立的祖先锁阻塞。

这些问题破坏 WebDAV 并发控制，没有证明未经账号认证的访问。规范补核确认：[RFC 4918 §9.9.2](https://www.rfc-editor.org/rfc/rfc4918.html#section-9.9.2) 的集合 MOVE 头部须按规则作用于后代；[§9.10.3](https://www.rfc-editor.org/rfc/rfc4918.html#section-9.10.3) 明确无限深度 LOCK 覆盖所有成员，不能在有成员被现有锁阻挡时仍部分成功。

**建议：** 根据操作影响范围检查整个子树的有效锁。集合 MOVE 源删除需与递归 DELETE 保持一致；申请无限深度锁需先验证后代冲突。冲突检查和锁写入还应与 A05 一起考虑原子性，否则先扫描再写仍有竞争窗口。

**修复状态：** 已修复。集合 MOVE 源改用 `assertRecursiveDeletePermission` 检查全部后代；新建 depth infinity 锁在写入前调用 `assertNoDescendantLockConflicts`，有后代锁时返回 423；A05 的 Durable Object 守卫进一步把检查与写入串行化。

## A05：并发排他锁可同时成功，随后互相覆盖

**首次目录 sidecar：** `directories.ts:206` 在不存在 sidecar 时使用空写选项 `{}`，没有 create-if-absent 条件。让两个首次 `LOCK /docs/` 都读到不存在的 sidecar 后再写，两个请求均返回 201、各自返回不同 token，最终存储仅保留其中一个。`locking.ts:196` 的重读/重试无法修补缺失的条件创建。

**文件：** `storage.ts:648` 在重写时重新读取文件 body，但传入的锁元数据来自更早的状态。一个请求在最初锁检查后暂停，另一个成功加锁，再恢复第一个；后者读取最新 body/etag，却写入旧状态推导的另一把锁。两个请求均 201，最终只有一个 token。本地 Miniflare R2 还验证了文件内容不变的 metadata-only rewrite 保持 ETag，因而 `etagMatches` 不能检测该锁元数据变化。Cloudflare [R2 官方文档](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2object-definition) 将每次上传的唯一 `version` 与 `etag` 分列，没有承诺把内容 ETag 当成所有 metadata 变化的版本。这里的具体双 201 与 ETag 行为证据仍为隔离本地 R2，未请求生产存储验证。

**建议：** 缺失记录使用条件创建，存在记录使用能代表锁状态变化的版本做条件更新。将文件锁状态放入具有独立版本的记录，或通过 Durable Object 等方式串行化同一资源/层级的锁状态；不要把文件内容 ETag 当作锁元数据版本。应同时验证并发 LOCK、UNLOCK、PUT 与 PROPPATCH。

**修复状态：** 目录 sidecar 首次写已改为 `onlyIf: { etagDoesNotMatch: '*' }`。并发锁与跨方法写操作改由 `src/domain/mutation-guard.ts` 的 `MutationGuardDurableObject` 协调：所有 Worker 实例通过 `idFromName('global')` 访问同一 DO，`acquire` 在 `blockConcurrencyWhile` 中清理过期项并原子检查 shared/exclusive 冲突，`release` 按 token 删除；目标路径取 exclusive，祖先（含根路径）取 shared，因此根路径 LOCK 会阻止子资源 PUT/DELETE，同资源/父子资源冲突返回 423，不同资源可并行。LOCK/UNLOCK 与 dispatch 中的 PUT/DELETE/MKCOL/PROPPATCH/COPY/MOVE 共用该守卫；Worker 层绑定缺失时写请求返回 503；只有直接调用 handler 的测试使用 R2 CAS 回退。DO 仍使用 SQLite-backed 存储的 key-value API，但把单个 `guards` 数组改为 `guard:<token>` 分键记录，避免单 value 超过 128 KiB；租约 120 秒，Worker 每 30 秒 POST `/renew` 续期，容量上限为 256 个活动 token、4096 条记录，单请求最多 1024 条路径、路径字符预算 32 KiB，超限返回 503。本地 dev 已验证根 LOCK 201 → 子资源 PUT 423 → UNLOCK 204 → PUT 204，DO 测试和全量单测 `183/183` 通过。残余是续期连续失败/DO 驱逐后的旧持有者、绕开 dispatch 直接调用 handler、单实例吞吐，以及 R2 带外写入；DO 串行化不是存储级事务。30 秒心跳目前由 DO `/renew` 单测和普通本地 smoke 覆盖，尚未用超过 30 秒的实际 PUT/COPY 做端到端续期验证。`isLost()` 已通过 guard-aware bucket 在每次 `put`/`delete` 前检查，丢失后返回 503；这能阻止丢失后的新写入，但不能撤销已经提交的单个 R2 操作。

## A06：失效的版本条件未阻止修改

- `mutations.ts:109` 的 DELETE 只检查 `If-Unmodified-Since`；`If-Match: "stale"` 仍返回 **204** 并删除文件。已在本地 R2 再确认。
- `proppatch.ts:44` 同样只检查时间条件；带过期 `If-Match` 的 PROPPATCH 返回 **207** 并存入新属性。
- `locks.ts:503` 遇到不匹配的 WebDAV `If` ETag 条件时只跳过 token 收集，没有把整个条件判假；最终 `:570` 也不能拒绝纯 ETag 假条件。在无锁资源上发送 `If: (["stale"])` 的 DELETE 返回 **204** 并删除。

同一内存 R2 模型中，带过期 If-Match 的 PUT 会正确得到 412，作为模型确实支持条件请求的对照。

正常同步客户端可能因此删除或改写自己尚未读取过的新版资源，造成丢失更新。这是协议和数据完整性问题。

**规范补核：** [RFC 9110 §13.1.1](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.1) 要求方法执行前求值 If-Match，条件不满足时不得执行；[RFC 4918 §10.4.1](https://www.rfc-editor.org/rfc/rfc4918.html#section-10.4.1) 明确 WebDAV If 为假时必须返回 412。与锁 token 提交相关的规则不能替代 ETag 条件求值。Cloudflare [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#bucket-method-definitions) 将 `onlyIf` 用于 get/put，公开的 `delete(key: string | string[]): Promise<void>` 没有条件参数；强一致性也不使分开的检查和删除变成原子操作。

**建议：** 在所有适用方法中一致求值 HTTP 条件头与 WebDAV If 列表；假条件必须在修改前返回 412，不能只拿 If 当 token 提取器。存储支持时使用条件操作；对 R2 的检查到删除窗口采用串行化或等价机制，不依赖公开 API 中不存在的条件删除选项。

**修复状态：** 已修复应用层缺口。`assertIfMatch` 已用于 DELETE 和 PROPPATCH；`evaluateIfHeaderConditions` 在锁检查前整体求值，假条件返回 412；dispatch 的 Durable Object 层级守卫把应用层请求的“检查—删除/写入”串行化，包含根路径与父子资源。但 R2 公开 API 没有条件 delete，绕开 Worker 的带外删除仍不受保护，因此这不是存储级原子事务。

## A07：浏览器访问上传文件时存在同源活动内容风险

`content.ts:28` 以 `image/` 前缀作为安全内联类型，包含可以执行脚本的 `image/svg+xml`。`:65` 的附件兜底又只在原始 metadata 没有 Content-Disposition 时生效；PUT 在 `mutations.ts:79` 存储用户提交的 HTTP metadata，因此 `Content-Type: text/html` 加 `Content-Disposition: inline` 可直接跳过附件保护。

鉴权入口 PUT→GET 重现确认：含脚本 SVG 返回原始内容、`Content-Type: image/svg+xml`，没有 attachment 或 CSP；显式 inline HTML 返回 `Content-Disposition: inline`。已验证服务端前提，没有启动真实浏览器或自动化演示脚本执行。[SVG 2 官方处理模式](https://svgwg.org/svg2-draft/conform.html#referencing-modes) 明确区分直接浏览的文档与作为 image 子资源加载：直接浏览可使用允许脚本的 dynamic interactive 模式，`img`/CSS 图像通常使用禁止脚本的 secure 模式。因此风险判断取决于文档打开方式，不能写成所有 SVG 显示都会执行脚本。

**影响条件：** 用户通过浏览器打开不可信上传内容时，浏览器可在 WebDAV 服务 origin 中处理活动文档；其脚本可能利用同源上下文和可用的认证状态发起操作。所有当前账号本已共享 bucket，因此不将此表述成凭空新增的租户越权或已证实窃取 Basic 密码。风险主要是把不可信文件内容提升到服务 origin 的信任级别。

**建议：** 将活动格式从内联白名单中排除，且不要让可上传的 Content-Disposition 覆盖安全策略。对 HTML/SVG 等强制附件或施加禁止脚本的 CSP sandbox；若需要预览，使用无应用凭据的独立 origin。补充 `X-Content-Type-Options: nosniff` 作为辅助，但它不能单独阻止声明为 SVG/HTML 的脚本。

**修复状态：** 已实施缓解。HTML/XHTML/SVG/XML/JS 等活动类型强制 attachment，覆盖上传的 inline disposition，并加 nosniff 与 `CSP: sandbox; default-src 'none'; frame-ancestors 'none'`；text/plain 仍可 inline。未实现独立预览 origin，因此这是降低同源活动内容风险，不是完整隔离。

## A08：交付与 CI 保护在当前版本中不可靠

`git ls-files` 不包含 `scripts/` 和 `.github/`；本地 `.gitignore:180`、`:184` 明确忽略二者。已跟踪的 `package.json:7` / `:8` 依赖 `scripts/wrangler-dev.sh`，`:9` 依赖 `scripts/fix-test-build-imports.mjs`；`tests/directory-sidecar.test.js:28` 也导入迁移脚本。因此新的 checkout 缺少必需运行/测试文件，本地成功不能代表干净 checkout 可复现。本地存在的 litmus workflow 也不是已交付 CI 的证据。

即便将当前本地 workflow 纳入版本控制，`.github/workflows/litmus.yml:28` 固定 Node 20，而锁定的 [Wrangler 4.113.0 官方 manifest](https://registry.npmjs.org/wrangler/4.113.0) 与 Miniflare 要求 Node ≥22；Wrangler 启动代码对低版本主动退出，不只是 npm engine 警告。[Node.js 官方支持计划](https://raw.githubusercontent.com/nodejs/Release/main/schedule.json) 还确认 Node 20 已于 **2026-04-30** EOL。两个 actions 已固定完整 SHA，且 [checkout v4.4.0](https://github.com/actions/checkout/releases/tag/v4.4.0) 与 [setup-node v4.4.0](https://github.com/actions/setup-node/releases/tag/v4.4.0) 官方发布页分别指向 workflow 中的提交；没有将它们误报为浮动或未知来源引用。

**建议：** 调整忽略规则并提交必需脚本和 CI 文件，在受支持 Node 版本上从干净 checkout 执行 unit/check/litmus。将依赖审计或持续公告提醒纳入实际交付的控制。没有检查远端 GitHub UI/组织规则，不能断言远端完全没有其他保护。

**修复状态：** 本地已修复并随 `4a85eff` 提交。`.gitignore` 不再忽略 `.github/`、`scripts/`、`.gitignore`，workflow 改为 Node 22；`git ls-files` 已确认这些文件进入版本库。仍需远端 push 后观察 CI 实际运行，并完成 litmus 验证，因此“远端 CI 已保护”尚不能仅凭本地提交断言。

## A09–A11：其他已复现协议缺陷

规范补核确认，[RFC 4918 §9.2](https://www.rfc-editor.org/rfc/rfc4918.html#section-9.2) 要求 PROPPATCH 按文档顺序处理；[§9.10.7 官方 LOCK 示例](https://www.rfc-editor.org/rfc/rfc4918.html#section-9.10.7) 使用的正是 `<D:write/>` 命名空间形式。因此下面两项并非仅某个客户端的私有约定。

- **A09，低：** `proppatch.ts:124` 把所有 set 先执行，再执行所有 remove。目录属性在同一文档中先 remove 再 set 时，本应保留最后 set 的新值，实际返回 207 后属性缺失。文件分支则按原顺序执行。应按解析后的操作序列更新目录属性，维持事务和失败语义。
- **A10，中，兼容性：** `locking.ts:65` / `:66` 使用 `<shared` / `<write` 正则。合法 `<D:lockinfo xmlns:D="DAV:">…<D:write/>…</D:lockinfo>` 被返回 400；带前缀的 shared/owner 也不能可靠识别。应在受限 XML 解析后按 namespaceURI/localName 提取 LOCK 字段，避免仅匹配拼写。
- **A11，低：** `xml.ts:192` / `:197` 未检查 documentElement 是否存在。仅含 `<!-- comment only -->` 或 XML 声明的 PROPFIND/PROPPATCH 解析都会抛出 `Cannot read properties of null (reading 'localName')`，入口没有将其转成 400。应将无根文档作为无效 XML 处理，并覆盖空文档、仅声明和仅注释。

**修复状态：** A09 已改为按 operations 顺序执行；A10 已用命名空间感知的 `parseLockRequest` 解析 LOCK，标准 `D:` 前缀通过；A11 已加 `documentElement` null 防护，无根 XML 返回无效请求。三者均有回归用例。

## A12：开发工具链公告命中、升级结果与 bundle 边界

它们不是线上 Worker 的运行时依赖：应用 `src/` 只导入 xmldom，未配置 Cloudflare Images 绑定，也没有调用 `fetch` 的 `cf.image`。但开发机、CI 和发布流程会执行这些代码，且部分组件被 Wrangler 打包进单文件 CLI，npm audit 的包级计数不会单列这些内嵌模块。

- **Undici 7.28.0（升级前的 Miniflare 传递版本）：** 官方 OSV 精确版本查询返回 **23 条 GHSA**，覆盖重定向缓存、内容编码/解压、cookie、WebSocket、TLS Agent 选项、SRI、EventSource 等。覆盖本批范围的 7.x 补丁目标至少为 **7.30.1**；部分问题仅在使用相应可选能力时才有意义，不能按 23 条全部计为已到达本项目的执行路径。Miniflare 的 Node 端 HTTP 使用 Undici。
- **sharp 0.34.5（升级前的 Miniflare 传递版本）：** 返回 **3 条 GHSA**，来自继承的 libvips/libheif/librsvg 原生库，修复目标分别为 0.35.0、0.35.4、0.35.5；统一以 **0.35.5** 为验收线。只有实际解码不受信图像时才触发相应路径，当前项目没有配置 Images，普通 WebDAV 字节传输不会自动解码。
- **npm audit 计数：** 两次独立的只读审计都返回 **5 个 high 受影响包条目、36 条独立公告**（10 xmldom + 23 Undici + 3 sharp）；将 xmldom 升到 0.8.15 后，修复后审计为 **4 个 high 包条目、26 条公告**（Undici 23 + sharp 3），保存在 `.tmp/security-audit/npm-audit-post-fix-2026-11-07.json`。Miniflare/Wrangler 是传导条目，不重复计数。普通响应 `fixAvailable: false`、隔离 lockfile 响应为 true，该布尔值不能替代精确补丁版本。升级 Wrangler 4.158.0 后，隔离审计为 **0 条**，见下一段。
- **bundle 单列：** Wrangler 的发布说明涉及已打包组件的修复，锁文件不按内嵌模块逐项列出。升级前曾在旧 `node_modules/wrangler/wrangler-dist/cli.js` 中读到内嵌版本（例如 `yaml@2.8.1`、`minimatch@5.1.6`、`brace-expansion@2.0.1`），这些组件也存在版本范围命中；4.158.0 的 bundle 内容已改变，仍需按新 CLI 复核，不能把旧读取结果或 npm 的 36 条当成完整清单，也不能假设升级 CLI 就一定已覆盖全部内嵌依赖。
- **workerd：** 官方公告中的 [GHSA-8vx6-69vg-c46f](https://github.com/cloudflare/workerd/security/advisories/GHSA-8vx6-69vg-c46f)（CVE-2023-2512）影响 `<1.20230419.0`，当前锁定版本早已超出，且官方说明在 Workers 资源限制下从未可利用；不把它算作当前未修复项。开发链补核报告另列该系统公告中与本项目版本无关或已修复的其余条目。

**升级结果（2026-11-07）：** 已将 `wrangler` 升至 **4.158.0**，锁文件带入 `miniflare 5.20261104.0-beta`、`undici 7.30.1`、`sharp 0.35.5`、`workerd 1.20261104.1`、`esbuild 0.28.2`。`npm ci` 从干净安装成功，`npx tsc --noEmit` 通过，`npm run test:unit` **183/183** 通过，本地 `wrangler dev` 的 `PROPFIND / Depth:0` 返回 207；升级后隔离 `npm audit --package-lock-only` 为 **exit 0、0 条**。这消除的是 npm 可见的开发链公告，不等于 bundle 内嵌模块和所有上游代码已被证明无风险。

**残余边界：** Miniflare 5 仍是 beta，Wrangler 4.158.0 的兼容性尚未经过 litmus 和长时间运行验证；bundle 内嵌组件仍需按实际 4.158.0 CLI 重新核对，不能把 npm 0 条当成完整清单。升级前 26 条与升级后 0 条均保留为历史对照。

## 后门与供应链检查结果

本次完整阅读的应用代码中，未发现硬编码万能密码、隐藏认证豁免路径、任意 eval/动态代码执行、主动外传请求或混淆载荷。`atob` 用于 Basic 解码；唯一明确的应用日志是 R2 列表错误及操作上下文，没有看到代码记录 Authorization/密码。

根 package 无 install/postinstall 等 hooks。93 个 lockfile resolved 都指向 HTTPS npm 官方 registry，并含 SHA512 integrity；没有发现 git/file/link 或异常域名依赖源。开发依赖 esbuild/workerd/sharp 有正常工具安装执行面，workerd 的平台包缺失回退路径还存在额外下载信任边界，详细记录见依赖报告。这些事实不等于已验证所有已安装文件、上游发布者或二进制供应链完整性。

保留 sidecar 命名空间、跨 origin Destination 拒绝、XML 文本转义、XML 流式大小累计、未认证拒绝等已有控制已阅读核对。没有把 CORS 反射 Origin 直接报成可窃取未知凭据，也没有把本地 workerd 版本或 compatibility_date 当作线上 Cloudflare 补丁版本。

## 验证结果与复现材料

| 验证                                                  | 结果                                                                                                                                                                                                                                |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run test:unit`                                   | 修复前 **142/142 通过**；修复后 **183/183 通过**（新增 41 条安全回归）                                                                                                                                                              |
| `npx tsc --noEmit`                                    | 通过                                                                                                                                                                                                                                |
| `npm run check`（全量）                               | 修复前 Prettier 因原有未跟踪 `.agents/`、`.forge/` 和 `skills-lock.json` 共 23 个文件失败；本次对修改文件单独 check 通过                                                                                                            |
| 对 Git 已跟踪的 TS/JS/JSON/Markdown 做 Prettier check | **通过**，用于定位全量格式失败的来源                                                                                                                                                                                                |
| 只读 `npm audit`（网络恢复后两次）                    | exit 1；**5 个 high 包条目、36 条独立公告**，是漏洞结果，不是执行错误                                                                                                                                                               |
| 修复后隔离 `npm audit`（升级 Wrangler 前）            | exit 1；xmldom 已消失，仍为 **4 个 high 包条目、26 条开发链公告**                                                                                                                                                                   |
| 升级 Wrangler 4.158.0 后隔离 `npm audit`              | **exit 0；0 条公告**；Miniflare 5 beta 仍需兼容性验证                                                                                                                                                                               |
| `npm ci` 干净安装 + unit/typecheck + dev smoke        | 通过；183/183、tsc 通过、`PROPFIND / Depth:0` 返回 207                                                                                                                                                                              |
| `main-repro.mjs`                                      | 通过；鉴权入口下条件请求、内容响应、文件锁及路径别名重现                                                                                                                                                                            |
| `reviewer-repro.mjs` / `post-fix-repro.mjs`           | 初版通过并重现错误；修复后版本验证 Depth、子树锁、If、LOCK、PROPPATCH 等新行为                                                                                                                                                      |
| `xml-complexity-repro.mjs`                            | 通过；128 MiB 堆上限下受控性能测量                                                                                                                                                                                                  |
| `local-r2-repro.mjs`                                  | 最终通过；本地 R2 确认内容 ETag、过期删除、无效 COPY、文件排他锁竞争和路径别名                                                                                                                                                      |
| 业务代码、依赖、配置、已有测试 Git diff               | A01–A11、xmldom 0.8.15、CI/忽略规则、163 条测试已提交 `4a85eff`（后续新增 DO/XML 上限与回归测试后为 170）；Wrangler 4.158.0 升级已提交 `423fac2`；DO 协调器与 3 条 DO 测试已提交 `06ebf61`；fail-closed 与 XML 预算已提交 `f9d6051` |
| 生产/远程 R2、部署、正式迁移、litmus                  | 未运行；没有访问生产凭据或数据                                                                                                                                                                                                      |

复现文件在 `.tmp/security-audit/`，不进入版本控制。先从项目根目录运行 `npm run test:unit` 生成 `.tmp/test-build`，再运行：

```sh
node .tmp/security-audit/main-repro.mjs
node .tmp/security-audit/reviewer-repro.mjs
node --max-old-space-size=128 .tmp/security-audit/xml-complexity-repro.mjs
node .tmp/security-audit/local-r2-repro.mjs
```

初版复现脚本的断言确认当时错误行为，不能直接作为修复后应继续通过的期望测试；修复后使用 `post-fix-repro.mjs` 和新增回归测试验证新行为。`local-r2-repro.mjs` 使用隔离目录 `.tmp/security-audit/r2-local` 和本地 Miniflare/workerd；Node 与 workerd 代理传输会丢失已知长度 stream 标记，首次尝试因此失败。最终版本仅在测试代理边界把 stream 缓冲为已知长度字节，保留真实 R2 条件、ETag 与 metadata 行为，重跑成功；未把首次传输适配异常误报为生产缺陷。

初次审计 JSON 保存在 `.tmp/security-audit/npm-audit.json`（1 包、10 条，SHA256 `5b514db38d7409aedb2fe20dd81b53b52caed0e4c338579aebbf69be3b082249`），作为历史响应保留。网络恢复后的普通审计保存在 `.tmp/security-audit/npm-audit-online-2026-11-07.json`（SHA256 `4cbd8deddebfa387a98cd68ca0ab58a9fd491f639abdb6fbc16b7b20081e3fe0`），隔离 lockfile 审计保存在 `.tmp/security-audit/npm-audit-online-lock-only-2026-11-07.json`（SHA256 `a51792850f1808b07eb7e09c2bc080260c155216ab88f8162df58915268d0851`），两者均为 5 包条目、36 条公告。修复后隔离审计保存在 `.tmp/security-audit/npm-audit-post-fix-2026-11-07.json`（513 行，SHA256 `90910300e845fd74366975f989d84e3561a35b9cc4fe2625bf4dbb81c9220412`），4 包条目、26 条公告。Wrangler 4.158.0 升级后的隔离审计保存在 `.tmp/security-audit/npm-audit-wrangler-upgrade-2026-11-07.json`（22 行，SHA256 `4b1f5dc8672b8c30f077bec9ffba09fd8ecd0798d16dc9b4c946877aec8abdd3`），`metadata.vulnerabilities.total = 0`。CVE、公开日期与精确 patched version 来自官方公告补核，不写回初次 JSON。

## 资料局限与修复顺序

初次审计时搜索服务缺少 API 凭据、官方页面抓取被网络策略拒绝；网络恢复后已完成补核：直接读取 GitHub/OSV 公告、CVE/NVD 记录、npm manifest 与发行信息、Cloudflare 与 Node 官方文档、R2 Workers API 及 RFC 原文。xmldom 的 CVE、发布日期、跨分支范围和补丁版本，开发链 26 条公告，bundle 内嵌组件，actions 身份和 Node 支持周期均已核实，逐条来源见两份补核报告。GitHub API 的个别后续请求遇到匿名限流，已用官方 API、发布页和 commit patch 交叉验证，未把限流当作无漏洞证据。

仍需保留的边界：没有生产 R2/部署产物访问，不能证明实际托管实例的补丁状态；没有穷举未公开或所有第三方漏洞情报；没有进行真实浏览器脚本执行实验或线上 DoS 实验；bundle 的可利用性只按已读代码和调用链判断，未做完整反编译审计。没有把 npm 未命中、精确版本范围命中或公告计数等同于实际可利用性。

优先顺序：A01–A04、A06–A11 已在本工作树完成；A08 的脚本/CI 已随本次安全修复提交纳入版本库。A05 已用单实例 Durable Object 的 shared/exclusive 层级守卫覆盖 LOCK/UNLOCK 与主要变更方法，根路径 LOCK 也纳入守卫；残余是单实例吞吐、续期失败后的旧持有者和带外 R2 写入，而不是根路径缺口。A12 已升级 Wrangler 4.158.0 并取得 npm audit 0，但 Miniflare 5 beta 仍需 litmus 与长时间运行验证。每项修复应以本报告的触发条件反写最小回归，再跑现有 unit、check 和相关 litmus 套件。
