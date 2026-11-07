# 依赖与供应链安全研究：2026-11-07

查询及网络恢复后补核日期：**2026-11-07，Asia/Shanghai（UTC+08:00）**。对象为当前工作区的 TypeScript / Cloudflare Worker WebDAV 项目。以第一方资料、实际锁定版本和应用调用路径为依据；补核阶段不修改应用、依赖或配置，后续修复实施阶段单独更新了 xmldom、Wrangler 和锁文件。仓库已有 `docs/superpowers/` 下的日期化设计记录；本报告放在 `docs/` 根目录。

**修复实施后的变化（2026-11-07）：** 本工作树已将 `@xmldom/xmldom` 从 0.8.13 升到 **0.8.15** 并更新锁文件，未采用会破坏对象形式 `errorHandler` 的 0.9.12。只升 xmldom 时隔离 `npm audit --package-lock-only` 仍 exit 1，剩 **4 个 high 受影响包条目、26 条独立公告**（Undici 23 + sharp 3），结果保存在 `.tmp/security-audit/npm-audit-post-fix-2026-11-07.json`。随后把 `wrangler` 升到 **4.158.0**（提交 `423fac2`），锁文件带入 Miniflare `5.20261104.0-beta`、Undici **7.30.1**、sharp **0.35.5**；隔离审计变为 **exit 0、0 条**，保存在 `.tmp/security-audit/npm-audit-wrangler-upgrade-2026-11-07.json`。`npm ci`、`tsc --noEmit`、165 条单测和本地 dev `PROPFIND` 均通过。该报告其余“0.8.13/36 条/26 条”段落是升级前快照，保留用于追溯，不应作为当前工作树状态。

## 结论与证据强度

1. **优先处理线上 XML 解析依赖。** `@xmldom/xmldom` 初版实际锁定并已安装 **0.8.13**，命中 **10 条 GHSA（npm 分级为 8 high、2 moderate）**，包含二次 CPU/内存复杂度问题。网络恢复后已取得完整官方公告、CVE 和发布信息：覆盖这批公告的 0.8 分支修复版本为 **0.8.15**，0.9 分支对应 **0.9.12**，均已正式发布；部分序列化防护仍须显式启用 `requireWellFormed`。0.9.12 不再支持应用当前使用的对象形式 `errorHandler`，需要适配，当前兼容更新首选 0.8.15。**修复实施后已升到 0.8.15。** `PROPFIND`、`PROPPATCH` 可把已认证用户的 XML 送进解析器；1 MiB 请求体上限与先鉴权不能证明算法型 DoS 已消除。本研究未对线上 Worker 发起攻击或证明跨 isolate 影响。
2. **CI 存在确定的版本冲突与交付缺口。** 本地 workflow 选择 Node **20**，Wrangler **4.113.0** / Miniflare **4.20260721.0** 要求 Node **≥22.0.0**，Wrangler 启动入口还会对 Node <22 主动退出。官方支持周期现已补核，Node 20 于 **2026-04-30** 结束支持。本地 `.github/`、`scripts/` 被忽略且不在当前 Git 索引中，不能将这些本地文件视为已交付的 CI 控制。
3. **开发依赖也有官方公告命中，最新 npm audit 已确认。** 精确版本查询命中 **Undici 7.28.0 的 23 条 GHSA** 和 **sharp 0.34.5 的 3 条 GHSA**。网络恢复后，普通只读审计与关闭用户/全局配置的独立 lockfile 审计均返回 **5 个 high 受影响包条目、36 条独立 GHSA（18 high、15 moderate、3 low）**；5 个包条目含风险传导到的 Miniflare/Wrangler。初次仅返回 xmldom 的 10 条是历史响应，不能作为当前完整结论；修复掉 xmldom 后为 **4 个 high 包条目、26 条公告**，升级 Wrangler 4.158.0 后为 **0 条**。开发链命中不等于线上 WebDAV 可利用；默认本地开发监听 `0.0.0.0`、迁移工具可获取远程 R2 代理，仍须评估开发主机与凭据边界。完整列表、修复版本及功能可达性见 [Cloudflare 开发链补核](security-cloudflare-verification-2026-11-07.md)。
4. **已核实两个 actions SHA 的上游身份。** checkout 和 setup-node 的所固定提交均对应各自官方仓库的 **v4.4.0**；checkout 该版本的 `persist-credentials` 默认 **true**。锁文件 93 个包条目的 `resolved` 均为 npm 官方 HTTPS registry，均有 `sha512` integrity；安装 hooks、二进制回退路径及安装后文件的信任边界仍不能由这些字段替代验证。
5. **原有网页抓取故障已恢复，搜索凭据问题仍存在。** 已直接取回 GitHub、npm registry、CVE、NVD、Node.js 等第一方资料，补全下文明确列出的公告、版本、日期和 actions 身份。`web_search` 仍因缺少 `DEEPSEEK_API_KEY` 失败；本次通过直接访问官方 API 和文档完成补核。Cloudflare 托管实例的实际补丁状态、完整漏洞情报及未公开公告仍不属于已验证结论。

## 范围、方法与安全约束

已读取 `AGENTS.md`、`package.json`、完整 `package-lock.json`（lockfile v3）、`wrangler.toml`、本地 `.github/workflows/litmus.yml` / `CODEOWNERS`、三个 `scripts/` 文件、应用入口与 XML 处理路径。进一步静态读取了已安装 npm 包的 manifest、xmldom 发行说明和相关库源码、Wrangler Node 版本门禁及安装 hooks；网络恢复后又以官方 API 和发行页补核了公告、CVE、日期与版本，本地缓存内容仅作为对照。

补核研究阶段未执行 `npm install`、`npm ci`、`npm audit fix`、项目部署或迁移；未运行 Wrangler、esbuild、workerd 原生二进制，未执行无关未跟踪文件。未读取 `.dev.vars`、Cloudflare 凭据或用户 npm 配置，不输出环境变量。npm 审计使用独立缓存、关闭 hooks、禁用用户/全局 npm 配置并移除常见 npm token 环境变量。后续修复实施阶段先在本地 cache 安装 `@xmldom/xmldom@0.8.15` 并更新锁文件；之后在工作树中安装 `wrangler@4.158.0`，未部署、未迁移。成功命令如下：

```sh
# 最终隔离 lockfile 审计（普通非隔离审计另以 npm audit --json --ignore-scripts 运行）
env -u NODE_OPTIONS -u NPM_TOKEN -u NODE_AUTH_TOKEN \
  -u npm_config__auth -u NPM_CONFIG__AUTH \
  -u npm_config__authToken -u NPM_CONFIG__AUTHTOKEN \
  npm audit --package-lock-only --ignore-scripts --json \
  --registry=https://registry.npmjs.org \
  --userconfig=/dev/null \
  --globalconfig=/Users/wfz/workspace/r2-webdav/.tmp/security-audit/nonexistent-global-npmrc-20261107 \
  --cache=/Users/wfz/workspace/r2-webdav/.tmp/security-audit/npm-cache-online-20261107 --logs-max=0 \
  --fetch-retries=0 --fetch-timeout=30000
```

**历史记录与最终补核结果：** 初次退出码 1 的响应为 `auditReportVersion: 2`、1 个 high 包、10 条 xmldom 公告，保存在 `.tmp/security-audit/npm-audit.json`。此前保存的 `.tmp/network-recheck-npm-audit.json` 也曾返回相同结果。它们反映当次响应，不能覆盖后续查询。最终重新执行 `npm audit --json --ignore-scripts`，并另以以上隔离参数执行一次 `--package-lock-only` 审计（globalconfig/cache 改为仓库 `.tmp/security-audit/` 内不同路径），两次均返回 **5 个 high 包条目、36 条独立 GHSA**；退出码 1 是漏洞结果，不是命令故障。普通响应的 `fixAvailable` 为 false，隔离 lockfile 响应为 true，具体修复版本以已读取的上游公告和发布信息为准，不能从这个布尔字段推导。

最新普通审计保存为 `.tmp/security-audit/npm-audit-online-2026-11-07.json`，SHA256 `4cbd8deddebfa387a98cd68ca0ab58a9fd491f639abdb6fbc16b7b20081e3fe0`；独立 lockfile 审计保存为 `.tmp/security-audit/npm-audit-online-lock-only-2026-11-07.json`，SHA256 `a51792850f1808b07eb7e09c2bc080260c155216ab88f8162df58915268d0851`。只升 xmldom 后的隔离审计为 `.tmp/security-audit/npm-audit-post-fix-2026-11-07.json`（4 包、26 条，SHA256 `90910300e845fd74366975f989d84e3561a35b9cc4fe2625bf4dbb81c9220412`）；Wrangler 4.158.0 升级后的隔离审计为 `.tmp/security-audit/npm-audit-wrangler-upgrade-2026-11-07.json`（22 行，SHA256 `4b1f5dc8672b8c30f077bec9ffba09fd8ecd0798d16dc9b4c946877aec8abdd3`，0 条）。10+23+3 是升级前独立公告数；Miniflare/Wrangler 的传导条目不重复计数。审计仅向 npm registry 发送依赖名称/版本信息，不发送项目源码或应用凭据。

补核研究阶段没有运行源码回归测试：它不改变实现，目标是静态依赖/供应链研究，当时 `git diff --exit-code -- package.json package-lock.json wrangler.toml src .github scripts` 无差异。后续修复实施独立修改了源码、测试、xmldom、Wrangler 和锁文件，并运行 `npm ci`、`npm run test:unit`（165/165）、`npx tsc --noEmit`、本地 dev smoke 及修改文件的 Prettier check；这些结果见主审计报告的“修复实施状态”，不混入补核研究的静态结论。

## 实际版本与依赖链

下表是 **升级前快照**；升级后的当前值见紧随其后的第二张表。`package.json` 中的声明范围不能替代这些实际版本。

| 包 / 声明范围                        | 实际版本                  | 依赖链、用途                                                                             | 仓库证据                                                                                                          |
| ------------------------------------ | ------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `@xmldom/xmldom` / `^0.8.11`         | **0.8.13**                | 根 production dependency；`src/webdav/xml.ts` 导入 DOMParser；本包无 production 传递依赖 | `package.json:22`、`package-lock.json:1219`、`src/webdav/xml.ts:1`、`node_modules/@xmldom/xmldom/package.json:49` |
| `wrangler` / `^4.20.0`               | **4.113.0**               | 根 devDependency；开发、构建、部署、迁移脚本                                             | `package.json:6`、`package.json:19`、`package-lock.json:1521`、`scripts/migrate-directory-sidecars.mjs:495`       |
| `miniflare`                          | **4.20260721.0**          | `wrangler → miniflare`，本地模拟器                                                       | `package-lock.json:1532`、`package-lock.json:1336`                                                                |
| `workerd` 和 5 个平台包              | **1.20260721.1**          | `wrangler → workerd`；`wrangler → miniflare → workerd`；平台包为 optional                | `package-lock.json:46`、`package-lock.json:1346`、`package-lock.json:1500`、`package-lock.json:1535`              |
| `undici`                             | **7.28.0**                | `wrangler → miniflare → undici`，Node 端 HTTP 客户端                                     | `package-lock.json:1345`、`package-lock.json:1480`                                                                |
| `ws`                                 | **8.21.0**                | `wrangler → miniflare → ws`                                                              | `package-lock.json:1347`、`package-lock.json:1557`                                                                |
| `sharp` / `@img/sharp-*`             | **0.34.5**                | `wrangler → miniflare → sharp`，含 optional 本地平台包；libvips 包版本 **1.2.4**         | `package-lock.json:1344`、`package-lock.json:1400`、`package-lock.json:1418`                                      |
| `esbuild` / `@esbuild/*`             | **0.28.1**                | `wrangler → esbuild`，打包工具与 optional 平台二进制                                     | `package-lock.json:1269`、`package-lock.json:1531`                                                                |
| `path-to-regexp`                     | **6.3.0**                 | `wrangler → path-to-regexp`                                                              | `package-lock.json:1357`、`package-lock.json:1533`                                                                |
| `unenv` / `@cloudflare/unenv-preset` | **2.0.0-rc.24 / 2.16.1**  | Wrangler 的 Node 兼容打包支持                                                            | `package-lock.json:30`、`package-lock.json:1490`、`package-lock.json:1529`                                        |
| `youch` / `cookie`                   | **4.1.0-beta.10 / 1.1.1** | `wrangler → miniflare → youch → cookie`，开发错误页链                                    | `package-lock.json:1348`、`package-lock.json:1579`、`package-lock.json:1589`                                      |
| `@cloudflare/workers-types` / `*`    | **5.20260722.1**          | 根 devDependency；TypeScript 类型输入                                                    | `package-lock.json:131`、`tsconfig.json:36`                                                                       |
| `prettier` / `^3.1.1`                | **3.3.3**                 | 根 devDependency，格式化                                                                 | `package-lock.json:1405`                                                                                          |
| `typescript` / `^5.0.4`              | **5.6.3**                 | 根 devDependency，编译/静态检查                                                          | `package-lock.json:1505`                                                                                          |

**升级后的当前值（2026-11-07，Wrangler 4.158.0）：**

| 包 / 声明范围                | 当前版本              | 依赖链、用途                                          | 仓库证据                                                                                  |
| ---------------------------- | --------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `@xmldom/xmldom` / `^0.8.15` | **0.8.15**            | 根 production dependency；解析 PROPFIND/PROPPATCH XML | `package.json:22`、`package-lock.json:1256`、`src/webdav/xml.ts:1`                        |
| `wrangler` / `^4.158.0`      | **4.158.0**           | 根 devDependency；开发、构建、部署、迁移脚本          | `package.json:19`、`package-lock.json:1560`、`scripts/migrate-directory-sidecars.mjs:495` |
| `miniflare`                  | **5.20261104.0-beta** | `wrangler → miniflare`，本地模拟器；beta 需兼容性验证 | `package-lock.json:1373`、`:1560`                                                         |
| `workerd`                    | **1.20261104.1**      | `wrangler → miniflare → workerd`；本地运行时          | `package-lock.json:1539`、`:1560`                                                         |
| `undici`                     | **7.30.1**            | `wrangler → miniflare → undici`，Node 端 HTTP 客户端  | `package-lock.json:1519`、`:1560`                                                         |
| `sharp`                      | **0.35.5**            | `wrangler → miniflare → sharp`；libvips 本地平台包    | `package-lock.json:1434`、`:1560`                                                         |
| `esbuild`                    | **0.28.2**            | `wrangler → esbuild`，打包工具与平台二进制            | `package-lock.json:1306`、`:1560`                                                         |
| `@cloudflare/workers-types`  | **5.20261107.1**      | 根 devDependency；TypeScript 类型输入                 | `package.json:17`、`package-lock.json:131`                                                |

本地同版本 manifest 示例：`node_modules/wrangler/package.json:3`、`node_modules/miniflare/package.json:3`、`node_modules/undici/package.json:3`、`node_modules/ws/package.json:3`、`node_modules/@xmldom/xmldom/package.json:3`。本次没有重新下载 tarball，也没有对已安装文件逐一重算 tarball integrity；版本一致性不等同于本地依赖目录来源已验证。

应用 `src/` 的外部运行时导入为 xmldom；没有发现应用直接导入 Wrangler、Miniflare、Undici、ws 或 sharp。`nodejs_compat` 的存在不能证明所有 devDependencies 都被部署进 Worker，Wrangler 用到的兼容 shim 也不能只根据 `dev: true` 推断完全不会进入产物。本次未生成 bundle，精确 shim 清单尚未检查。

## npm audit 命中的 xmldom GHSA

**共同前提：** 下表实际安装版本均为 **0.8.13**，依赖链均为 `r2-webdav → @xmldom/xmldom`。本表保留 **2026-11-07 的 npm audit 响应**给出的范围和级别，用于与静态应用路径对照；网络恢复后已另行取回全部官方公告，CVE、各分支完整范围、修复版本和日期见“网络恢复后的官方资料补核”。npm 响应本身不含这些完整字段，不能仅凭 `fixAvailable: true` 推导修复版本。

| GHSA / 来源链接                                                          | npm 返回的精确受影响范围 | npm 级别与问题                                                     | 本项目可达性判断                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------ | ------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [GHSA-8344-3jmq-59r6](https://github.com/advisories/GHSA-8344-3jmq-59r6) | `>=0.7.0 <=0.8.14`       | high；Quadratic-time attribute deduplication                       | **解析路径可达。** DOMHandler 对每个属性调用 `setAttributeNode`，NamedNodeMap 又线性查找已有同名属性；大量不同属性可产生二次工作。缓存源码：`lib/dom-parser.js:167`、`lib/dom.js:286`、`lib/dom.js:300`。未测定生产 CPU 耗尽阈值。                                    |
| [GHSA-x4fp-j954-r2f4](https://github.com/advisories/GHSA-x4fp-j954-r2f4) | `>=0.7.0 <=0.8.14`       | high；End-tag Whitespace-Trim Regex ReDoS                          | **解析路径可达。** 缓存 `lib/sax.js:120` 的 `/[ \t\n\r]+$/g` 在结束标签解析中执行；应用只在完整 parse 返回后判错。没有通过本报告实施 ReDoS。                                                                                                                          |
| [GHSA-965w-775f-mr7g](https://github.com/advisories/GHSA-965w-775f-mr7g) | `>=0.7.0 <=0.8.14`       | high；Quadratic-memory consumption                                 | **解析路径可达，有相符源码机制。** 新命名空间声明会复制当前映射，嵌套栈持有逐层映射（缓存 `lib/sax.js:443`、`:447`、`:491`）。补核官方公告确认该映射复制机制；本研究未实施完整漏洞复现。                                                                              |
| [GHSA-93r5-fhx6-vmg9](https://github.com/advisories/GHSA-93r5-fhx6-vmg9) | `>=0.7.0 <=0.8.14`       | high；malformed-input recovery 重扫与 adjacent-text merge 二次解析 | **解析路径可达。** 应用收集错误但不中止 parse；缓存 SAX 的异常恢复继续扫描，endDocument 调用 normalize（`lib/sax.js:202`、`lib/sax.js:209`、`lib/dom-parser.js:214`、`lib/dom.js:535`）。即便最终返回 400，解析成本已发生。                                           |
| [GHSA-6h8r-xr42-gp59](https://github.com/advisories/GHSA-6h8r-xr42-gp59) | `>=0.7.0 <=0.8.14`       | npm moderate；非良构结束标签被静默接受；维护者现标为 Hardening     | **解析路径可达，但维护者最新仓库公告说明其不符合后来制定的漏洞资格，尚无 plausible exploit；公告未撤回。** global 数据库仍保留旧描述，不能把版本命中当作已证明攻击。0.8.15 默认产生 recoverable error；应用已有 error 收集会在解析后拒绝。详见 xmldom 补核报告。      |
| [GHSA-w2rr-34g9-rvrj](https://github.com/advisories/GHSA-w2rr-34g9-rvrj) | `>=0.7.0 <=0.8.13`       | high；`createElement()` 元素名注入绕过 requireWellFormed           | **未发现应用调用该 DOM 构造 API。** 本项目从 XML 字符串解析，缓存 SAX 校验标签名；不把包版本命中等同于构造 API 注入已可利用。                                                                                                                                         |
| [GHSA-4w3w-2rp5-g8jm](https://github.com/advisories/GHSA-4w3w-2rp5-g8jm) | `>=0.7.0 <=0.8.13`       | high；`setAttribute()` 属性名注入绕过 requireWellFormed            | **未发现应用调用该 DOM 修改 API。** 解析器内部的属性处理与应用把任意字符串传给 setAttribute 是不同路径。                                                                                                                                                              |
| [GHSA-6gmq-8vp8-gcm6](https://github.com/advisories/GHSA-6gmq-8vp8-gcm6) | `>=0.7.0 <=0.8.14`       | moderate；无效 `EntityReference.nodeName` 的片段注入               | **未发现应用创建或修改 EntityReference。** 缓存解析器按预定义/XML 数字实体替换文本；未证明攻击者可沿应用路径得到该恶意节点。                                                                                                                                          |
| [GHSA-c7q8-3ch8-vqpv](https://github.com/advisories/GHSA-c7q8-3ch8-vqpv) | `>=0.7.0 <=0.8.14`       | high；Processing Instruction target 注入绕过 requireWellFormed     | **序列化路径已加固。** 应用现在用带 `{ requireWellFormed: true }` 的 `XMLSerializer.serializeToString` 序列化解析所得子节点；非法 PI target 会使解析返回 null。应用没有自行调用 createProcessingInstruction 或修改 target，因此不能把历史公告前提直接套用到当前路径。 |
| [GHSA-27p8-2357-5qqv](https://github.com/advisories/GHSA-27p8-2357-5qqv) | `>=0.7.0 <=0.8.14`       | high；DocType name 注入绕过 requireWellFormed                      | **未发现应用创建/修改 DocumentType。** 应用序列化 dead property 子节点，并非直接序列化整个文档；现已启用 `requireWellFormed`，补核公告确认包级版本命中，但未证明应用可构造/修改攻击者指定名称的 DocumentType。                                                        |

上述缓存源码的完整路径前缀均为 `node_modules/@xmldom/xmldom/`。npm 返回各条 CVSS `score: 0` 且 `vectorString: null`；这里不把缺失评分解释为无风险，也不另编造 CVSS。

### 线上路径与已有缓解

- `src/app/worker.ts:24` 先检查鉴权，`:39` 才进入分发；未认证普通 WebDAV 请求不能到达 DOMParser，`OPTIONS` 则直接返回 options 响应（`src/app/dispatch.ts:56`）。这限制了本研究发现的解析器风险到**已获得账号的访问者**，未证明认证前利用。
- `src/webdav/methods/propfind.ts:146` 读取受限 body，`:150` 调用 `parsePropfindRequest`；`src/webdav/methods/proppatch.ts:49` / `:53` 对应 PROPPATCH。二者进入 `src/webdav/xml.ts:167` 的 `parseXmlDocument` 和 `:175` 的同步 DOMParser。
- `src/webdav/responses.ts:84` 将 XML body 限为 **1,048,576 bytes**，`:108` 同时计数流式读取，不能仅伪造较小 Content-Length 绕过该累计检查。长度上限没有限制每元素属性数、命名空间声明数、嵌套深度或解析器内部操作总量。
- `src/webdav/xml.ts:171` 忽略 warning，`:172` / `:173` 累积 error/fatalError，直到 `parseFromString` 返回后才在 `:176` 检查；它不会在算法复杂度成本发生前终止解析。
- `LOCK` 在 `src/webdav/methods/locking.ts:65` 至 `:70` 通过正则和 owner 提取逻辑处理，不走这里的 xmldom DOMParser；不能把所有接收 XML 的方法统一算作这些 GHSA 的入口。
- `src/webdav/xml.ts:154` 至 `:157` 拒绝 dead property 中 DAV 命名空间后代，有助于约束协议注入，却不是解析器 CPU/内存问题的修复。

**修复落地（已核实版本，已执行升级）：** npm 官方元信息及上游公告确认，同分支最小候选为 **0.8.15**；**0.9.12** 也是已发布的修复版本，但不是当前代码可直接替换的候选：[0.9.12 DOMParser 源码](https://raw.githubusercontent.com/xmldom/xmldom/0.9.12/lib/dom-parser.js) 对对象形式的 `errorHandler` 主动抛出 `TypeError`，而 `src/webdav/xml.ts:169` 正在使用该形式，迁移时必须适配 `onError` 及异常处理。已先在 0.8 分支最小化更新 dependency/lockfile 到 0.8.15，并复测 PROPFIND/PROPPATCH、XML 往返和错误输入。0.8 分支 `XMLSerializer.serializeToString(node, isHtml, nodeFilter, options)` 的 options 为第 4 参数；当前 `src/webdav/xml.ts` 的 `serializeNodeChildren` 已显式传入 `{ requireWellFormed: true }`，非法 PI target 会返回无效请求。版本升级、序列化校验与应用可达性仍须分别验证，仅启用该选项不能代替解析器 DoS 修复。详见下文官方补核表及 [0.8.15 DOM 源码](https://raw.githubusercontent.com/xmldom/xmldom/0.8.15/lib/dom.js)。

## 已包含的历史修复与条件性修复

本节初次依据**已安装 0.8.13 包内的上游 CHANGELOG 和源码**。网络恢复后已取回这六条上游完整公告，核实分支范围、CVE 和公开/更新日期；补核数据见后文。本表继续说明当前代码是否实际使用已提供的修复或可选防护。

| 包内发行说明 / 上游来源                                                                                                                                                                                                                                                                                                   | 精确已知修复版本或条件                                                                                          | 对当前项目的含义                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [GHSA-wh4c-j3r5-mjhp](https://github.com/xmldom/xmldom/security/advisories/GHSA-wh4c-j3r5-mjhp)，缓存 `CHANGELOG.md:26` / `:31`                                                                                                                                                                                           | **0.8.12**：createCDATASection 拒绝 `]]>`；序列化把含 `]]>` 的 CDATA 拆段                                       | 锁定 **0.8.13** 包含该行为；`lib/dom.js:1336` / `:1904` 有相符代码。不把它继续列为当前未修复项。完整历史公告已在线补核，跨分支范围见 xmldom 补核报告。                                                                 |
| [GHSA-2v35-w6hq-6mfw](https://github.com/xmldom/xmldom/security/advisories/GHSA-2v35-w6hq-6mfw)，缓存 `CHANGELOG.md:15`                                                                                                                                                                                                   | **0.8.13**：若干 DOM 遍历改为迭代，修复库自身深树递归栈耗尽                                                     | 当前锁文件已包含该库修复；不代表应用自己的递归遍历或其他 CPU/内存问题也被修复。                                                                                                                                        |
| [GHSA-j759-j44w-7fr8](https://github.com/xmldom/xmldom/security/advisories/GHSA-j759-j44w-7fr8)、[GHSA-x6wf-f3px-wcqx](https://github.com/xmldom/xmldom/security/advisories/GHSA-x6wf-f3px-wcqx)、[GHSA-f6ww-3ggp-fr8h](https://github.com/xmldom/xmldom/security/advisories/GHSA-f6ww-3ggp-fr8h)，缓存 `CHANGELOG.md:11` | **0.8.13 提供可选防护**：第 4 参数 `{ requireWellFormed: true }` 校验 comment / PI data / DocumentType 部分内容 | 修复实施已启用该选项：`serializeNodeChildren` 使用带 `{ requireWellFormed: true }` 的 `XMLSerializer.serializeToString`，并对失败返回 null；新增非法 PI target 回归。启用防护不等于已证明所有 dead property 输入安全。 |
| [CVE-2022-39353 / GHSA-crh6-fp67-6883](https://github.com/xmldom/xmldom/security/advisories/GHSA-crh6-fp67-6883)，缓存 `CHANGELOG.md:112` / `:116`                                                                                                                                                                        | **0.8.4** 修复非良构 DOM 插入                                                                                   | **0.8.13** 包含该历史修复；未把它冒充近期 CVE。官方历史公告已在线补核，跨分支范围与日期见 xmldom 补核报告。                                                                                                            |

## 开发 Wrangler / Miniflare 与 Cloudflare 托管边界

- `wrangler.toml:2` 指向 `src/index.ts`；`:5` 开启 `nodejs_compat`；唯一外部应用解析依赖如上。Wrangler/Miniflare 的 Node HTTP 客户端 Undici、WebSocket ws 和 sharp 的本地原生库不因出现在 npm lockfile 中就自动成为线上 WebDAV 处理路径。
- `workerd 1.20261104.1` 是升级后 npm 开发链中的本地运行时版本（`package-lock.json:1539`）。**不能从它推导 Cloudflare 线上基础设施的确切运行时版本、补丁状态或某条上游 workerd 公告是否影响该线上 Worker。** `wrangler.toml:1` 的 `compatibility_date = "2023-10-16"` 也不能作为线上补丁版本证据。网络恢复后已取得 Cloudflare 官方安全模型和公开公告，但它们没有提供本项目实际托管实例的运行时/补丁清单，仍不能独立验证该实例的具体补丁状态。
- `scripts/wrangler-dev.sh:13` 默认 `--ip 0.0.0.0`，`package.json:7` / `:8` 将 dev/start 指向该脚本。本地服务会对可到达该监听端口的主机开放，实际边界还取决于 Docker 映射/防火墙；这是一项明确的开发配置暴露面，不能仅因 devDependency 不部署便忽略。建议普通主机开发默认 loopback，容器需要时再明确设置 `WRANGLER_DEV_IP`。
- `scripts/wrangler-dev.sh:7` / `:11` 和迁移脚本 `:494` 把默认 XDG 配置位置放到 `.tmp/xdg`，已有 `XDG_CONFIG_HOME` 仍会被保留；这只调整默认目录，不是隔离或访问控制机制。迁移脚本 `:495` 导入 Wrangler，`:504` 检查 remote 配置，`:510` 获取 platform proxy，正式模式会写/删对象（`:553` / `:554`）。本研究未运行它。
- 升级前两次 npm audit 与 OSV/GitHub 精确版本查询均确认 `undici 7.28.0`、`sharp 0.34.5` 存在公告命中，风险传导到 Miniflare/Wrangler。Undici 7.x 覆盖本次命中的补丁目标至少 **7.30.1**，sharp 至少 **0.35.5**；当前已升级到包含这些版本的 Wrangler 4.158.0/Miniflare 5 beta，升级后隔离 audit 为 0。仍不能假设升级 CLI 一定覆盖全部 bundle 内嵌模块；未确认当前 WebDAV 实现会触发全部 26 条升级前公告。其他精确版本查询为空的结果也不构成安全保证。

## 供应链与 CI 的具体检查

> 安装器行为表保留升级前版本号作为历史快照；Wrangler 4.158.0 更换了 esbuild/workerd 版本，未对其安装脚本逐行重新审计。

### 1. 本地 CI 与关键脚本没有纳入当前版本控制（优先恢复交付）

`git ls-files` 列出 tracked 文件，但没有 `.github/`、`scripts/`、`docs/superpowers/`。`git check-ignore -v` 明确给出：

```text
.gitignore:179:docs/superpowers/  docs/superpowers/specs/2026-03-22-directory-sidecar-design.md
.gitignore:180:.github/          .github/workflows/litmus.yml
.gitignore:184:scripts/          scripts/wrangler-dev.sh
```

因此报告对 workflow 的判断只适用于**本地存在的文件**。在当前 Git 索引对应的新 checkout 中，没有证据表明该 workflow、CODEOWNERS 或 dev/test/migration 脚本会随仓库交付；而 tracked `package.json:7` / `:9` 又引用其中的脚本。这既影响可复现开发/测试，也使本地认为存在的 CI 审查措施失去可交付性。应调整忽略策略并将必要脚本和 CI 纳入版本控制；本研究没有修改它们或暂存文件。

### 2. 本地 CI Node 20 与锁定工具存在确定冲突

- `.github/workflows/litmus.yml:28` 为 `node-version: 20`，`:32` 执行 `npm ci`，`:48` 启动 Wrangler。
- `package-lock.json:1543` 和 `:1354` 的 engine 都是 `>=22.0.0`。
- 已安装 `node_modules/wrangler/bin/wrangler.js:5` 定义 `MIN_NODE_VERSION = "22.0.0"`，`:12` 至 `:21` 在 Node 版本不足时设置退出码 1 并返回。

即使 npm 没有因 engine mismatch 阻止安装，Wrangler 的主动版本检查仍会使该启动步骤失败，等待服务阶段将不能完成。建议 CI 与受支持的 Node ≥22 版本对齐并实际运行检查，避免通过压低旧 Wrangler 来掩盖版本冲突。网络恢复后已依据 Node.js 官方 release schedule 补核支持周期，Node 20 已于 2026-04-30 EOL；见后文 Node 表。

### 3. Actions 固定、权限与其他浮动输入

| 本地观察                                                                      | 证据                                                                                                              | 判断                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| checkout 与 setup-node 均使用完整 SHA                                         | workflow `:23` 为 `11d5960a326750d5838078e36cf38b85af677262`；`:26` 为 `49933ea5288caeca8642d1e84afbd3f7d6820020` | **未发现按可变 tag 引用 actions。** 已从各自官方仓库核实这两个 SHA 均对应 v4.4.0，`# v4` 主版本注释准确；固定 SHA 仍需持续审查与更新，证据链接见后文。                                                                                         |
| workflow 只声明 `contents: read`；触发为 push/main 与 pull_request            | workflow `:3` 至 `:10`                                                                                            | 是已有的权限约束；没有看到 `pull_request_target` 或引用生产 secrets。测试 username/password 均为显式 `test`（`:17` / `:18`），不当作泄露的生产凭据。                                                                                           |
| `ubuntu-latest`、Node major、apt 包版本浮动                                   | workflow `:14` / `:28` / `:36` / `:37`                                                                            | action SHA 固定并不固定 runner image、Node patch 或 litmus apt 包；属于可复现性与供应商更新输入，未发现这里使用未知下载域或 curl-pipe-shell。                                                                                                  |
| `npx wrangler` 而非显式本地路径                                               | workflow `:48`                                                                                                    | 正常 `npm ci` 成功后应使用已安装 Wrangler；若依赖目录缺失，npx 还可能进入 registry 解析/安装路径。建议显式调用本地 Wrangler，缺包即失败；不能把当前行直接说成一定运行未锁定版本。                                                              |
| 安装步骤没有禁用 lifecycle hooks；checkout 未显式关闭 credentials persistence | workflow `:22` 至 `:32`                                                                                           | 任意被安装包的 hook 都属于 CI 执行面。所固定 checkout 的官方 action.yml 已确认 `persist-credentials` 默认 true，令牌写入 local Git config，post-job cleanup 删除；应减少安装期可读令牌/权限。本地 workflow 已有只读 token 权限且未见生产凭据。 |
| 未看到 Dependabot/Renovate 配置或 npm audit 步骤                              | 当前 `.github/` 文件发现结果及完整 workflow                                                                       | 当前本地文件集没有持续漏洞告警控制的证据；不能由此推断远端组织规则或 GitHub Dependabot UI 一定未启用。                                                                                                                                         |

### 4. 锁文件来源、安装 hooks 与二进制信任

完整读取 lockfile，并搜索所有 `resolved` / `integrity` 及 `hasInstallScript`、`git:`、`file:`、`link:` 等字段：**93 个 resolved 全部指向 HTTPS npm 官方 registry，对应 93 个 sha512 integrity，未发现 git/url/file/link 依赖、明文 HTTP 包源或异常域名。** 示例为 `package-lock.json:1221` / `:1222`、`:1271` / `:1272`、`:1523` / `:1524`。根 package 没有 preinstall/install/postinstall/prepare 脚本（`package.json:5` 至 `:14`）；项目未发现 `.npmrc`。

| 安装期输入             | 锁文件/缓存证据                                      | 具体行为与判断                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `esbuild 0.28.1`       | lock `:1274`；`node_modules/esbuild/package.json:10` | postinstall 为 `node install.js`；缓存 `install.js:269` 优先平台包，缺失时 `:188` 子 npm install、`:245` 直接 registry 下载，`:249` 有二进制 SHA256 校验，`:296` / `:298` 执行二进制 version 检查。环境 `ESBUILD_BINARY_PATH` 可覆盖路径（`:258`）。它是实际执行面，不是本次发现的恶意 hook。                                                                 |
| `workerd 1.20260721.1` | lock `:1505`；`node_modules/workerd/package.json:7`  | postinstall 为 `node install.js`；缓存 `install.js:219` 优先平台包，缺失时 `:155` 子 npm install 或 `:200` 直接 registry 下载，`:205` 提取后写入二进制，`:247` / `:249` 执行 version 检查。该直接下载分支中未见与 lockfile integrity 对照的检查；正常平台包路径仍受 npm lockfile 完整性约束。应保留平台 optional 包、审查回退路径，不能将版本检查当内容验证。 |
| `sharp 0.34.5`         | lock `:1405`；`node_modules/sharp/package.json:96`   | install 为 `node install/check.js` 失败时执行 `npm run build`；发现全局 libvips 或 build-from-source 时进入构建检查，可能调用 node-gyp（`install/check.js:8`、`install/build.js:24`/`:35`）。这些本地环境因素超出仅看 lockfile 的约束。                                                                                                                       |
| `fsevents 2.3.3`       | lock `:1316`，darwin-only optional                   | lock 标注 hasInstallScript，但缓存 manifest 只有 clean/build/test/prepublishOnly（`node_modules/fsevents/package.json:18`）；没有直接发现 preinstall/install/postinstall。未把这个标志虚构为已观察到的下载 hook；隐式构建条件和包归档内容未重新下载验证。在 Linux CI 上该 darwin optional 包通常不适用。                                                      |

`npm ci` 使用 lockfile 是已有的可复现性措施；它不会让 dependency hooks 自动失去执行权限。普通安装和本次审计是不同操作：本研究使用 `--ignore-scripts`，未执行这些 hooks。审计响应无法证明 npm 发布者账号、provenance/签名、上游构建过程或所有已安装文件未被篡改；本次未完成这些验证。

`package.json:16` 使用 `@cloudflare/workers-types: "*"`，其余多个依赖为 caret 范围。当前 `npm ci` 仍有 lockfile 约束；但重建锁文件/常规解析更新会放宽输入，特别是 types 的任意 major。建议在后续变更中采用明确更新策略，审阅 lockfile 差异和完整性变化，而不是把 `*` 当作已发生的依赖替换证据。

## 网络恢复后的官方资料补核

本节替代初次审计的“完整公告、补丁与日期尚待联网核实”结论；保留初次响应作为历史记录。完整逐条表分别见 [xmldom 补核报告](security-xmldom-verification-2026-11-07.md) 与 [Cloudflare 开发链补核报告](security-cloudflare-verification-2026-11-07.md)。

- **xmldom：** 精确查询 `@xmldom/xmldom@0.8.13` 返回 10 条当前未撤回的 GHSA；四条解析复杂度风险与当前应用入口相符，其他构造/序列化 API 的前提逐条判断。全局公告多于仓库首次公开日期之后同步，不能混用日期；CVE、各分支范围、published/updated/withdrawn 字段已从官方记录补全。当前兼容目标 0.8.15，0.9.12 需迁移对象形式 errorHandler；两条新序列化注入修复及若干历史修复仍有显式 `requireWellFormed` 前提。
- **上游后续定性：** 仓库最新 [GHSA-6h8r-xr42-gp59](https://github.com/xmldom/xmldom/security/advisories/GHSA-6h8r-xr42-gp59) 增加 2026-10-09 WARNING，说明按后来的安全策略应属于 Hardening，尚无 plausible exploit；原描述、评分和补丁未改，CVE 未撤回。全局数据库仍是旧描述，因此 10 条是命中数，不能等同于 10 个已证明的应用漏洞。
- **Undici / sharp：** 官方精确版本命中为 23+3 条，GitHub/OSV 范围交叉一致；覆盖本批命中的补丁目标分别为 Undici 7.30.1 与 sharp 0.35.5。Miniflare Node 端使用 Undici；部分公告要求额外启用 cache/retry/TLS/WebSocket 等特定功能，不能统一算作可达。sharp 继承的原生库问题需要相应图像解码路径；本项目未配置 Images 绑定，也未调用 `fetch` 的 `cf.image`，普通 WebDAV PUT/GET 传递字节不会自动调用 sharp 解码。
- **bundle 边界：** 新版 Wrangler 官方发布说明还涉及已 bundle 的依赖安全修复；npm lock/audit 不一定按内嵌模块独立列出。相关实际内嵌版本、精确命中与可达性在开发链补核报告单列，不能把 npm 返回的 36 条写成完整漏洞总数，也不能只凭升级 CLI 版本承诺全部修好。
- **Node / actions：** [Node.js 官方计划](https://raw.githubusercontent.com/nodejs/Release/main/schedule.json) 确认 Node 20 于 2026-04-30 EOL；当前 Wrangler/Miniflare 要求 ≥22。官方 [checkout v4.4.0 发布页](https://github.com/actions/checkout/releases/tag/v4.4.0) 与 [setup-node v4.4.0 发布页](https://github.com/actions/setup-node/releases/tag/v4.4.0) 分别指向本地 workflow 固定的完整 SHA；[精确 checkout 提交的 action.yml](https://raw.githubusercontent.com/actions/checkout/11d5960a326750d5838078e36cf38b85af677262/action.yml) 确认 `persist-credentials` 默认 true。当前使用的 `pull_request` 与只读 token 不应混同于 `pull_request_target` 的高权限执行场景。
- **Cloudflare / R2 / RFC：** 已直接取得 Cloudflare 托管安全模型、公开公告与 R2 Workers API；公开资料不能证明本项目实际托管实例的精确补丁状态。R2 get/put 的条件操作、公开 delete 无条件参数、version 与 etag 的区别均已核实。RFC 4918 / 9110 / 3986 支持主审计的属性顺序、Depth/锁、条件请求及保留分隔符判断；对 COPY/MOVE 覆盖删除行为已按规范收窄措辞，详见总报告。

## 建议顺序与验收

1. **线上优先：** 采用已核实的兼容补丁目标 **xmldom 0.8.15**，最小化更新 dependency/lockfile；序列化修复中依赖 `requireWellFormed` 的部分须显式采用该选项，不能只升级版本。验证 PROPFIND/PROPPATCH、dead property XML 往返和错误处理，并用有资源上限的专门用例验证解析复杂度；无需向生产发攻击请求。属性数、嵌套深度/命名空间声明总量限制和遇错及时终止可作为额外防线；当前实现已加入节点数 20,000、元素深度 64、属性数 5,000 的解析后预算，并保留 1 MiB 请求体上限。
2. **CI 优先：** 恢复关键脚本与 workflow 的 tracked 状态，把 Node 与 Wrangler 支持范围对齐；实际执行已有 unit/typecheck/format/litmus 门禁，避免只在本地拥有这些保护。核实 actions SHA 的上游身份并维持定期更新。
3. **开发与安装：** 按使用场景约束开发监听地址和远程 R2 访问；避免缺包时 npx 隐式获取工具。将安装、构建、部署凭据边界分离，保留对确有需要的 hooks 的审阅记录；避免使用 `--omit=optional` 迫使平台二进制进入下载回退。
4. **开发链更新验收（已执行）：** 已升级 Wrangler 4.158.0，带入 Undici 7.30.1、sharp 0.35.5；`npm ci`、`tsc`、165 条单测和本地 dev smoke 通过，隔离 audit 0。Wrangler 4.158.0 仍使用 Miniflare `5.20261104.0-beta`，litmus、长时间运行和 bundle 逐项复核尚未完成；不能把 beta 依赖的 audit 0 当作全面安全保证。生产部署身份与实际平台修补状态仍需账号内证据。

## 第一方来源与初次查询失败的历史记录

**下表仅保留初次审计的访问失败与当时使用方式，不是当前补核状态。** 网络恢复后已直接读取 GitHub 全局与仓库公告、CVE/NVD、npm 包 manifest/发行信息、Cloudflare 与 Node 官方页面；最终结果见本报告“网络恢复后的官方资料补核”及两份逐条补核报告。GitHub API 个别后续请求遇到匿名限流，已使用成功读取的官方 API、发行页与 commit patch 交叉验证；与原来的非公网 IP 拒绝不同。

| 第一方渠道 / URL                                                                                                                                                                                                             | 2026-11-07 初次查询结果                                                             | 初次报告如何使用                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [npm 官方 registry](https://registry.npmjs.org/)                                                                                                                                                                             | **npm audit 成功**，返回上表 10 条 GHSA；直接 web_fetch registry 包 manifest 被拒绝 | 当前在线漏洞标识、精确受影响范围、级别和 fixAvailable 的来源；未提供 CVE/公开日期/具体修复版本。 |
| [GitHub Advisory Database：xmldom API 查询](https://api.github.com/advisories?ecosystem=npm&affects=%40xmldom%2Fxmldom&per_page=100)                                                                                         | web_fetch：非公网 IP 拒绝                                                           | 未获得完整公告；上表具体 GHSA URLs 取自 audit，未冒充已成功阅读页面。                            |
| [Cloudflare workers-sdk 安全公告 API](https://api.github.com/repos/cloudflare/workers-sdk/security-advisories)                                                                                                               | 同上                                                                                | 未核实 Wrangler/Miniflare 最新公告；供后续核实。                                                 |
| [GitHub Advisory Database：Undici 7.28.0 查询](https://api.github.com/advisories?ecosystem=npm&affects=undici%407.28.0&per_page=100)                                                                                         | 同上                                                                                | 未核实完整版本公告覆盖；不以请求失败判断没有漏洞。                                               |
| [Cloudflare workerd 安全公告](https://github.com/cloudflare/workerd/security/advisories)                                                                                                                                     | 同上                                                                                | 未取得上游基础运行时公告，不将本地 runtime 版本映射为线上补丁结论。                              |
| [Cloudflare Workers 平台安全](https://developers.cloudflare.com/workers/platform/security/) 与 [Cloudflare 安全博客](https://blog.cloudflare.com/tag/security/)                                                              | 同上                                                                                | 未取得近期官方公告和托管平台修复状态。                                                           |
| [NVD xmldom 查询](https://nvd.nist.gov/vuln/search/results?form_type=Basic&results_type=overview&query=xmldom&search_type=all&isCpeNameSearch=false) 与 [CVE 查询](https://www.cve.org/CVERecord/SearchResults?query=xmldom) | 同上                                                                                | 未核实 CVE 对应关系、NVD 分析状态和评分，不编造编号。                                            |
| [Node.js 历史版本与支持状态](https://nodejs.org/en/about/previous-releases)                                                                                                                                                  | 同上                                                                                | CI 结论仅依赖已读取的精确 package engines 和启动代码，不依赖未取回的支持周期页面。               |
| [xmldom 上游 0.8.12…0.8.13 发行差异](https://github.com/xmldom/xmldom/compare/0.8.12...0.8.13) 与 [安全策略](https://github.com/xmldom/xmldom/security/policy)                                                               | 在线页面未取回；读取本地 `node_modules/@xmldom/xmldom/CHANGELOG.md` / `SECURITY.md` | 对既有修复的说明来自包内第一方缓存资料，不能证明它们最新状态或包发布日期。                       |

初次搜索工具发出的查询包括 `site.github.com/advisories "@xmldom/xmldom" 2026 0.8.13`、Wrangler 2026、Cloudflare workers-sdk security advisories、Undici 7.28.0；工具在返回搜索结果之前因缺少 `DEEPSEEK_API_KEY` 失败。本研究没有获取/输出该凭据，没有把搜索失败当作“没有新公告”。

**最终未覆盖事项：** 生产实际部署产物/版本与 Cloudflare 账号设置、远端仓库组织规则和 GitHub UI 状态、所有已安装文件/二进制的完整性与 provenance、未公开或所有第三方漏洞情报、所有 bundle 模块和应用触发链的穷举验证。本次匹配公告的 CVE、公开/更新/撤回状态与补丁版本已补核；没有从版本号日期片段推导发布日期，没有将版本范围命中或 npm 计数当作实际可利用性证明。
