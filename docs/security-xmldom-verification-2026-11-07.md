# xmldom 官方在线补核（2026-11-07）

核实日期：2026-11-07，Asia/Shanghai。所有下列发布、登记时间统一为 **UTC**，保留原始精度。补核基线为 HEAD `02a524e85eeb664f94801a789fd5f71ba347fb5b`，补核时实际锁定/已安装 `@xmldom/xmldom@0.8.13`；随后修复实施已升到 **0.8.15** 并更新锁文件，本报告正文的版本命中分析仍以补核时 0.8.13 为准。范围仅为 xmldom 网络缺口补核；全项目新一轮 npm audit、Undici/sharp/Cloudflare 开发链由主线程另行合并，本文件不把初次“仅 10 条 xmldom”当作全项目最新审计结论。

## 结论

1. **旧报告 10 条均有第一方完整记录，均命中 0.8.13，均未撤回。** 四条解析 CPU/内存 DoS 与当前同步解析入口相符，攻击前提是通过本项目认证并到达相应方法。公告 CVSS 的 PR:N 是库级模型，不能据此写成本服务匿名可利用。
2. **当前兼容维护线的目标是 0.8.15，npm latest 为 0.9.12、lts 为 0.8.15。** 四条 DoS 补丁在默认解析路径生效。0.9.12 会拒绝本项目当前的对象形式 errorHandler，需要代码迁移，不能仅改锁文件直接替换。
3. **升级不等于默认启用全部序列化防护。** 元素名、属性名、PI target、DocumentType.name 的新校验，以及 EntityReference 的序列化校验仍要求显式 requireWellFormed:true。本项目 [child.toString()](/Users/wfz/workspace/r2-webdav/src/webdav/xml.ts#L54) 没传选项；五条构造型注入的实际请求利用链也不能从包版本命中直接推导。
4. **结束标签条目已被维护者重新标为 [Hardening]。** 仓库公告于 2026-10-08 22:20:18Z 更新，新增标注日期为 2026-10-09 的警告：按后来制定的政策，该行为不满足漏洞条件，未展示可信利用方式，DOM 与良构输入相同。原分数/修复不改、CVE 不撤回；GitHub 全局库当前正文尚未同步。保留它作为数据库命中和输入校验加固事实，避免与四条可达 DoS 等量齐观。来源：[仓库最新全文](https://github.com/xmldom/xmldom/security/advisories/GHSA-6h8r-xr42-gp59)、[全局库](https://github.com/advisories/GHSA-6h8r-xr42-gp59)、[当前安全政策](https://github.com/xmldom/xmldom/security/policy)。
5. **已检查超出旧 10 条的全集，未发现影响 0.8.13 的第 11 条公告。** 全局 scoped 包查询 23 条、精确版本查询 10 条、仓库 24 条，全部无分页续页；五条额外 2026 公告只影响 0.9 分支。仓库额外的一条是旧 unscoped xmldom 公告，不是当前 scoped 依赖新增漏洞。

## 10 条精确版本与撤回状态

范围保留 [GitHub 全局 API](https://api.github.com/advisories?ecosystem=npm&affects=%40xmldom%2Fxmldom&per_page=100) 的原始字符串；每行链接到完整公告与已取回的 CVE 官方记录。scoped 指 @xmldom/xmldom；unscoped 指旧包 xmldom，后者已停止发布，表内受影响条目无上游补丁。首个补丁版本是公告元数据，不代表序列化检查默认开启。表中 0.7 也受影响，但维护者不再为 0.7 单独发补丁。

| GHSA / CVE                                                                                                                                    | CVSS 4.0 | scoped 0.7/0.8 受影响范围 | scoped 0.9 受影响范围 | 旧 unscoped xmldom   | scoped 首个补丁版本 | withdrawn  |
| --------------------------------------------------------------------------------------------------------------------------------------------- | -------: | ------------------------- | --------------------- | -------------------- | ------------------- | ---------- |
| [GHSA-8344-3jmq-59r6](https://github.com/advisories/GHSA-8344-3jmq-59r6)<br>[CVE-2026-83613](https://cveawg.mitre.org/api/cve/CVE-2026-83613) |      8.7 | `>= 0.7.0, <= 0.8.14`     | `>= 0.9.0, <= 0.9.11` | `<= 0.6.0`           | `0.8.15` / `0.9.12` | 否（null） |
| [GHSA-x4fp-j954-r2f4](https://github.com/advisories/GHSA-x4fp-j954-r2f4)<br>[CVE-2026-83619](https://cveawg.mitre.org/api/cve/CVE-2026-83619) |      8.7 | `>= 0.7.0, <= 0.8.14`     | 不受影响              | 不受影响             | `0.8.15`            | 否（null） |
| [GHSA-965w-775f-mr7g](https://github.com/advisories/GHSA-965w-775f-mr7g)<br>[CVE-2026-83615](https://cveawg.mitre.org/api/cve/CVE-2026-83615) |      8.7 | `>= 0.7.0, <= 0.8.14`     | `>= 0.9.0, <= 0.9.11` | `>= 0.1.5, <= 0.6.0` | `0.8.15` / `0.9.12` | 否（null） |
| [GHSA-93r5-fhx6-vmg9](https://github.com/advisories/GHSA-93r5-fhx6-vmg9)<br>[CVE-2026-83614](https://cveawg.mitre.org/api/cve/CVE-2026-83614) |      8.7 | `>= 0.7.0, <= 0.8.14`     | `>= 0.9.0, <= 0.9.11` | `>= 0.3.0, <= 0.6.0` | `0.8.15` / `0.9.12` | 否（null） |
| [GHSA-6h8r-xr42-gp59](https://github.com/advisories/GHSA-6h8r-xr42-gp59)<br>[CVE-2026-83611](https://cveawg.mitre.org/api/cve/CVE-2026-83611) |      6.9 | `>= 0.7.0, <= 0.8.14`     | `>= 0.9.0, <= 0.9.11` | `<= 0.6.0`           | `0.8.15` / `0.9.12` | 否（null） |
| [GHSA-w2rr-34g9-rvrj](https://github.com/advisories/GHSA-w2rr-34g9-rvrj)<br>[CVE-2026-83607](https://cveawg.mitre.org/api/cve/CVE-2026-83607) |      8.7 | `>= 0.7.0, <= 0.8.13`     | `>= 0.9.0, <= 0.9.10` | `<= 0.6.0`           | `0.8.14` / `0.9.11` | 否（null） |
| [GHSA-4w3w-2rp5-g8jm](https://github.com/advisories/GHSA-4w3w-2rp5-g8jm)<br>[CVE-2026-83605](https://cveawg.mitre.org/api/cve/CVE-2026-83605) |      8.7 | `>= 0.7.0, <= 0.8.13`     | `>= 0.9.0, <= 0.9.10` | `<= 0.6.0`           | `0.8.14` / `0.9.11` | 否（null） |
| [GHSA-c7q8-3ch8-vqpv](https://github.com/advisories/GHSA-c7q8-3ch8-vqpv)<br>[CVE-2026-83616](https://cveawg.mitre.org/api/cve/CVE-2026-83616) |      8.7 | `>= 0.7.0, <= 0.8.14`     | `>= 0.9.0, <= 0.9.11` | `<= 0.6.0`           | `0.8.15` / `0.9.12` | 否（null） |
| [GHSA-27p8-2357-5qqv](https://github.com/advisories/GHSA-27p8-2357-5qqv)<br>[CVE-2026-83608](https://cveawg.mitre.org/api/cve/CVE-2026-83608) |      8.7 | `>= 0.7.0, <= 0.8.14`     | `>= 0.9.0, <= 0.9.11` | `<= 0.6.0`           | `0.8.15` / `0.9.12` | 否（null） |
| [GHSA-6gmq-8vp8-gcm6](https://github.com/advisories/GHSA-6gmq-8vp8-gcm6)<br>[CVE-2026-83610](https://cveawg.mitre.org/api/cve/CVE-2026-83610) |      6.3 | `>= 0.7.0, <= 0.8.14`     | `>= 0.9.0, <= 0.9.11` | `<= 0.6.0`           | `0.8.15` / `0.9.12` | 否（null） |

十条 CVE 官方记录状态均为 PUBLISHED；GitHub 全局与仓库 withdrawn_at 均为 null。8 条 high（8.7）、2 条 moderate（6.9 / 6.3）是上游当前库级评分。EntityReference 的较低分也反映其特定 DOM API 前提；结束标签条目的最新 hardening 说明见上文。

## 不同日期来源

仓库 advisory 首次公开、GitHub 全局库登记、CVE 登记、NVD 登记与 npm/GitHub release 是不同事件。**不能把 9 月的数据库日期写成 8 月补丁的发布日期。** 下表使用各自官方字段；修复发布日期见下一节的 npm time 与 release published_at。

| GHSA                                                                     | 仓库 advisory published_at                                                                      | GitHub 全局库 published_at | CVE datePublished                                                          |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------- |
| [GHSA-8344-3jmq-59r6](https://github.com/advisories/GHSA-8344-3jmq-59r6) | [2026-08-21 22:50:08](https://github.com/xmldom/xmldom/security/advisories/GHSA-8344-3jmq-59r6) | 2026-09-08 21:01:31        | [2026-09-01 14:38:49.617](https://cveawg.mitre.org/api/cve/CVE-2026-83613) |
| [GHSA-x4fp-j954-r2f4](https://github.com/advisories/GHSA-x4fp-j954-r2f4) | [2026-08-21 22:50:10](https://github.com/xmldom/xmldom/security/advisories/GHSA-x4fp-j954-r2f4) | 2026-09-08 21:01:09        | [2026-09-01 14:51:28.121](https://cveawg.mitre.org/api/cve/CVE-2026-83619) |
| [GHSA-965w-775f-mr7g](https://github.com/advisories/GHSA-965w-775f-mr7g) | [2026-08-21 22:50:08](https://github.com/xmldom/xmldom/security/advisories/GHSA-965w-775f-mr7g) | 2026-09-08 21:00:52        | [2026-09-01 14:44:05.884](https://cveawg.mitre.org/api/cve/CVE-2026-83615) |
| [GHSA-93r5-fhx6-vmg9](https://github.com/advisories/GHSA-93r5-fhx6-vmg9) | [2026-08-21 22:50:11](https://github.com/xmldom/xmldom/security/advisories/GHSA-93r5-fhx6-vmg9) | 2026-09-08 21:00:41        | [2026-09-01 14:41:42.582](https://cveawg.mitre.org/api/cve/CVE-2026-83614) |
| [GHSA-6h8r-xr42-gp59](https://github.com/advisories/GHSA-6h8r-xr42-gp59) | [2026-08-21 22:50:16](https://github.com/xmldom/xmldom/security/advisories/GHSA-6h8r-xr42-gp59) | 2026-09-08 21:02:13        | [2026-09-01 14:34:12.618](https://cveawg.mitre.org/api/cve/CVE-2026-83611) |
| [GHSA-w2rr-34g9-rvrj](https://github.com/advisories/GHSA-w2rr-34g9-rvrj) | [2026-08-12 19:51:35](https://github.com/xmldom/xmldom/security/advisories/GHSA-w2rr-34g9-rvrj) | 2026-09-08 20:31:08        | [2026-09-01 14:23:58.797](https://cveawg.mitre.org/api/cve/CVE-2026-83607) |
| [GHSA-4w3w-2rp5-g8jm](https://github.com/advisories/GHSA-4w3w-2rp5-g8jm) | [2026-08-12 19:51:36](https://github.com/xmldom/xmldom/security/advisories/GHSA-4w3w-2rp5-g8jm) | 2026-09-08 20:30:51        | [2026-09-01 14:18:20.752](https://cveawg.mitre.org/api/cve/CVE-2026-83605) |
| [GHSA-c7q8-3ch8-vqpv](https://github.com/advisories/GHSA-c7q8-3ch8-vqpv) | [2026-08-21 22:50:12](https://github.com/xmldom/xmldom/security/advisories/GHSA-c7q8-3ch8-vqpv) | 2026-09-08 21:03:28        | [2026-09-01 14:45:44.504](https://cveawg.mitre.org/api/cve/CVE-2026-83616) |
| [GHSA-27p8-2357-5qqv](https://github.com/advisories/GHSA-27p8-2357-5qqv) | [2026-08-21 22:50:12](https://github.com/xmldom/xmldom/security/advisories/GHSA-27p8-2357-5qqv) | 2026-09-08 21:02:51        | [2026-09-01 14:27:26.057](https://cveawg.mitre.org/api/cve/CVE-2026-83608) |
| [GHSA-6gmq-8vp8-gcm6](https://github.com/advisories/GHSA-6gmq-8vp8-gcm6) | [2026-08-21 22:50:13](https://github.com/xmldom/xmldom/security/advisories/GHSA-6gmq-8vp8-gcm6) | 2026-09-02 15:18:20        | [2026-09-01 14:31:49.409](https://cveawg.mitre.org/api/cve/CVE-2026-83610) |

四条 DoS 的 NVD 记录另已独立读取；均为 Deferred，8.7 是 NVD 转载的 GitHub CNA CVSS 4.0 数据，不能称为 NVD 独立复评分。各 CVE CNA 的受影响范围与 GHSA 相符。

| CVE / NVD 官方 JSON                                                                     | NVD published（UTC）    | NVD vulnStatus | 评分来源 / CVSS 4.0                  |
| --------------------------------------------------------------------------------------- | ----------------------- | -------------- | ------------------------------------ |
| [CVE-2026-83613](https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2026-83613) | 2026-09-01T15:17:39.583 | Deferred       | security-advisories@github.com / 8.7 |
| [CVE-2026-83619](https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2026-83619) | 2026-09-01T15:17:40.657 | Deferred       | security-advisories@github.com / 8.7 |
| [CVE-2026-83615](https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2026-83615) | 2026-09-01T15:17:39.887 | Deferred       | security-advisories@github.com / 8.7 |
| [CVE-2026-83614](https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2026-83614) | 2026-09-01T15:17:39.733 | Deferred       | security-advisories@github.com / 8.7 |

## 实际发布、npm dist-tags 与源代码证据

官方 [完整 npm packument](https://registry.npmjs.org/@xmldom%2fxmldom)、[独立 dist-tags 接口](https://registry.npmjs.org/-/package/@xmldom/xmldom/dist-tags)、[GitHub release 列表](https://api.github.com/repos/xmldom/xmldom/releases?per_page=100) 相互印证：**lts=0.8.15、latest=0.9.12**；两分支没有更晚稳定版本。0.8.14 仅先修复元素名/属性名两条，0.8.15 才覆盖本次四条 DoS。旧 0.8.13、0.8.14、0.9.11 manifest 均已有 deprecated 提示；最新两版没有该提示。

| 版本 / registry manifest                                     | npm time（UTC）         | GitHub release published_at（UTC）                                          | manifest gitHead                           | deprecated |
| ------------------------------------------------------------ | ----------------------- | --------------------------------------------------------------------------- | ------------------------------------------ | ---------- |
| [0.8.13](https://registry.npmjs.org/@xmldom%2fxmldom/0.8.13) | 2026-04-18 11:27:55.806 | [2026-04-18 11:29:19](https://github.com/xmldom/xmldom/releases/tag/0.8.13) | `e5c14802592685bb872c042c54c3f73758875c85` | 是         |
| [0.8.14](https://registry.npmjs.org/@xmldom%2fxmldom/0.8.14) | 2026-08-12 19:19:55.967 | [2026-08-12 19:23:27](https://github.com/xmldom/xmldom/releases/tag/0.8.14) | `8a83f8ebf53604a733cb580bfc4ff9c0ae014d92` | 是         |
| [0.8.15](https://registry.npmjs.org/@xmldom%2fxmldom/0.8.15) | 2026-08-21 22:20:29.920 | [2026-08-21 22:21:33](https://github.com/xmldom/xmldom/releases/tag/0.8.15) | `b5b8fb5b579ae1183b34e74b3bc39d7eb50a226a` | 否         |
| [0.9.11](https://registry.npmjs.org/@xmldom%2fxmldom/0.9.11) | 2026-08-12 19:37:06.526 | [2026-08-12 19:43:19](https://github.com/xmldom/xmldom/releases/tag/0.9.11) | `1f0610959ab7b82cc7ad702d1be0243efc5791c0` | 是         |
| [0.9.12](https://registry.npmjs.org/@xmldom%2fxmldom/0.9.12) | 2026-08-21 22:32:42.389 | [2026-08-21 22:33:47](https://github.com/xmldom/xmldom/releases/tag/0.9.12) | `0af8cf829d8a92bbac612903422c6947f5458f06` | 否         |

0.8.14 的两条新校验对应 2026-08-12 发布；另外八条的 0.8 首个修复版是 2026-08-21 发布的 0.8.15，其中七条在 0.9 分支对应同日的 0.9.12（结束标签 ReDoS 从未影响 0.9）。这两版发布时，北京时间已是 8 月 22 日。[0.8.15 CHANGELOG](https://raw.githubusercontent.com/xmldom/xmldom/0.8.15/CHANGELOG.md)、[0.9.12 CHANGELOG](https://raw.githubusercontent.com/xmldom/xmldom/0.9.12/CHANGELOG.md)、各实际 tag 的 dom/sax/dom-parser 源码及下文 17 个不同修复提交均已只读取回并核实补丁逻辑。manifest 的 gitHead / integrity / tarball 字段已保存；没有下载 npm tarball、执行包代码或验证制品签名，不把元数据核对表述成制品内容认证。

## 逐条机制、默认行为与实际可达性

共同调用边界由当前源码确定：

- [worker](/Users/wfz/workspace/r2-webdav/src/app/worker.ts#L23) 在 dispatch 前验证所有非 OPTIONS 请求；[OPTIONS](/Users/wfz/workspace/r2-webdav/src/app/dispatch.ts#L57) 不调用 XML 解析。常规入口需要有效凭据，未证明匿名链。
- [PROPFIND](/Users/wfz/workspace/r2-webdav/src/webdav/methods/propfind.ts#L146) 和 [PROPPATCH](/Users/wfz/workspace/r2-webdav/src/webdav/methods/proppatch.ts#L49) 先读受限 body 后解析；部分 PROPPATCH 锁/前置条件可先短路。根节点、属性以及资源存在性检查发生在完整 DOM 解析后。
- [parseXmlDocument](/Users/wfz/workspace/r2-webdav/src/webdav/xml.ts#L167) 同步 parseFromString(body, 'application/xml')，warning 忽略、error/fatalError 追加数组，等解析返回后才判断是否拒绝；当前错误门禁不限制解析过程的 CPU/内存。
- [body 限制](/Users/wfz/workspace/r2-webdav/src/webdav/responses.ts#L84) 为 1024×1024 字节，包含流式累计；未发现独立属性数、嵌套深度或命名空间预算。上游公开测量中，多属性 340,894 字节即可明显耗时，命名空间约 56 KB 可产生远大于输入的内存开销；这些只证明 1 MiB 门槛不足，不是本 Worker 的实测容量或延迟。未执行公告 PoC、压力请求或远程攻击。

### GHSA-8344-3jmq-59r6 / CVE-2026-83613：多属性插入 CPU 二次复杂度

解析器依次向 NamedNodeMap 插入不同属性，每次线性扫描已插入集合，M 个属性累计 O(M²)。输入可以完全良构并不产生任何 error，错误回调与根元素校验都不能挡住开销。补丁用解析期间的名字索引消除重复扫描。

**本项目：** 直接可达：PROPFIND / PROPPATCH 在检查根节点和资源存在前同步解析完整请求。补丁在默认解析路径生效，不依赖严格序列化。 来源：[仓库全文](https://github.com/xmldom/xmldom/security/advisories/GHSA-8344-3jmq-59r6)；[0.8 修复提交](https://github.com/xmldom/xmldom/commit/2c548f200cfec991cd5846627ef8f03542309213)；[0.9 修复提交](https://github.com/xmldom/xmldom/commit/cfb09b5dbeb035fdfedc9f01e2bbaf226bf47cf3)。

### GHSA-x4fp-j954-r2f4 / CVE-2026-83619：结束标签 trim 正则 ReDoS

仅 0.8 维护线的未锚定尾部空白正则会在不匹配后反复从后续位置重新扫描，累积二次回溯。错误可能要在耗时扫描之后才报告。补丁替换为覆盖整串的线性 trim；0.9 分支从未受此条影响。

**本项目：** 直接可达 parseFromString。收集错误后再返回 400 不会回收已消耗的 CPU；0.8.15 默认路径修复。 来源：[仓库全文](https://github.com/xmldom/xmldom/security/advisories/GHSA-x4fp-j954-r2f4)；[0.8 修复提交](https://github.com/xmldom/xmldom/commit/3abb0934f5a8a84d83a1f9cde0f2bd04c08b2a09)。

### GHSA-965w-775f-mr7g / CVE-2026-83615：命名空间快照导致二次峰值内存

每层嵌套加入新命名空间时复制完整在作用域内的映射，并在开放元素栈保留各层快照，产生 N(N+1)/2 个条目。完整 DOM 本身可保持线性，仍可在解析期间内存爆炸。补丁以 Object.create(currentNSMap) 继承映射，避免逐层完整复制。

**本项目：** 直接可达，1 MiB 仅限制输入字节；没有独立深度或命名空间预算。0.8.15 / 0.9.12 默认路径修复。 来源：[仓库全文](https://github.com/xmldom/xmldom/security/advisories/GHSA-965w-775f-mr7g)；[0.8 修复提交](https://github.com/xmldom/xmldom/commit/954370f58c046223faf95ba77efcbc8ce014409d)；[0.9 修复提交](https://github.com/xmldom/xmldom/commit/dabffe884e864eeecb1f515c716f875e1bc47ec1)。

### GHSA-93r5-fhx6-vmg9 / CVE-2026-83614：畸形扫描恢复 + normalize 二次 CPU

标签扫描把内嵌 < 吞到后续 >，抛错后仅前进很少字符而重新扫描；恢复产生的大量相邻文本节点又被 endDocument.normalize() 逐个合并并重建索引，形成两个 O(N²) 阶段。补丁既在内嵌 < 处尽早结束扫描，也整段收集文本后一次合并/更新，缺一不足。

**本项目：** 直接可达 parseFromString 自带的 endDocument/normalize 路径；应用没有显式 normalize 调用也会触发。0.8.15 / 0.9.12 默认路径修复。 来源：[仓库全文](https://github.com/xmldom/xmldom/security/advisories/GHSA-93r5-fhx6-vmg9)；[0.8 修复提交](https://github.com/xmldom/xmldom/commit/f40ccb861eee0acbf5ee4feb9a34932e87b329c9)；[0.9 修复提交](https://github.com/xmldom/xmldom/commit/0748720b620555f8c222782dcab575cf0cf403b4)。

### GHSA-6h8r-xr42-gp59 / CVE-2026-83611：[Hardening] 畸形结束标签残余被静默接受

合法名称后带异常残余的结束标签会关闭元素并丢弃残余。0.8 无锚定验证，空格和换行变体都受影响；0.9 的多行锚点使换行变体漏检。没有注入额外内容，得到的 DOM 也可用良构 XML 构造。0.8.15 新增 recoverable error；0.9.12 XML 为 error、HTML 为 warning，解析仍可恢复且输出保持相同。

**本项目：** 解析行为可达，当前 error 数组会在升级后据此拒绝请求。维护者 2026-10-09 声明本条按新政策不够资格成为漏洞，尚无可信利用方式；它仍在数据库且未撤回，不按已证明攻击计。 来源：[仓库全文](https://github.com/xmldom/xmldom/security/advisories/GHSA-6h8r-xr42-gp59)；[0.8 修复提交](https://github.com/xmldom/xmldom/commit/4430189660b0d380ee9c9ee7550a1358688e8828)；[0.9 修复提交](https://github.com/xmldom/xmldom/commit/7b2ec67e1750daadd0bb06c92e875e726544a362)。

### GHSA-w2rr-34g9-rvrj / CVE-2026-83607：元素名称及命名空间前缀注入

createElement(tagName) 接收未验证名称，序列化原样输出；旧 requireWellFormed 分支也未校验 QName。0.8.14 / 0.9.11 在严格模式校验元素 QName 以及合成 xmlns 前缀并抛 InvalidStateError。默认序列化与创建时校验缺口不变。

**本项目：** 需攻击者控制 DOM 构造/变异中的名称后再序列化。应用没有 createElement 等直接调用，解析器会验证普通元素名；尚未证明这个直接 API 向量由请求触发。child.toString() 未启用新保护。 来源：[仓库全文](https://github.com/xmldom/xmldom/security/advisories/GHSA-w2rr-34g9-rvrj)；[0.8 修复提交](https://github.com/xmldom/xmldom/commit/d8212e632507eaf1d9f609657dd4c56abeb12d44)；[0.9 修复提交](https://github.com/xmldom/xmldom/commit/cba1321218b069182695813fa7565653708e172e)。

### GHSA-4w3w-2rp5-g8jm / CVE-2026-83605：属性名称及命名空间前缀注入

setAttribute 走不验证名字的私有创建路径；值虽转义，名字仍原样输出。0.8.14 / 0.9.11 在严格模式校验属性 QName 与合成 xmlns 声明，创建时校验仍待破坏性版本。

**本项目：** 需攻击者控制 setAttribute 的名称或直接变异节点名；应用无这些调用，普通 XML 属性名受解析器语法检查。当前实际利用未证明；默认 child.toString() 不会启用补丁中的严格校验。 来源：[仓库全文](https://github.com/xmldom/xmldom/security/advisories/GHSA-4w3w-2rp5-g8jm)；[0.8 修复提交](https://github.com/xmldom/xmldom/commit/d8212e632507eaf1d9f609657dd4c56abeb12d44)；[0.9 修复提交](https://github.com/xmldom/xmldom/commit/cba1321218b069182695813fa7565653708e172e)。

### GHSA-c7q8-3ch8-vqpv / CVE-2026-83616：ProcessingInstruction target 注入

createProcessingInstruction 接收 target，序列化原样输出 target。补丁严格模式要求 NCName 且禁止大小写不敏感的 xml 目标；创建时行为及默认序列化保持不变。

**本项目：** 应用无显式创建/变异 PI API；但 SAX 会内部创建 PI，不能仅据搜索结果宣称完全不可达。现有请求到危险 target 再到死属性序列化的完整利用链未证明。0.8.15 默认 child.toString() 仍无该严格检查。 来源：[仓库全文](https://github.com/xmldom/xmldom/security/advisories/GHSA-c7q8-3ch8-vqpv)；[0.8 修复提交](https://github.com/xmldom/xmldom/commit/3b694872bcb5c7e3cbadba961a4be2488750ce5b)；[0.9 修复提交](https://github.com/xmldom/xmldom/commit/1cde3e31a07c41c87cfd368d6946aa477f16b4f9)。

### GHSA-27p8-2357-5qqv / CVE-2026-83608：DocumentType.name 注入

doctype.name 被原样拼接；0.8 创建时不验证，0.9 创建校验也可被可写 name 属性绕过。补丁仅在 requireWellFormed 模式要求合法 XML Name；默认输出与创建缺口保持。

**本项目：** 应用没有 createDocumentType 或属性变异，且只序列化死属性子节点，未序列化整个文档/doctype。公告直接构造型注入向量未证明在这里可达。 来源：[仓库全文](https://github.com/xmldom/xmldom/security/advisories/GHSA-27p8-2357-5qqv)；[0.8 修复提交](https://github.com/xmldom/xmldom/commit/85f12eb4d14b44de33216cfb72b50af4d24e9fdd)；[0.9 修复提交](https://github.com/xmldom/xmldom/commit/57aec90ac57b4408ae7c5d1746bf2a693b5ed90e)。

### GHSA-6gmq-8vp8-gcm6 / CVE-2026-83610：EntityReference 名称注入

非法 name/nodeName 会被序列化为实体引用并可改变后续解析结构。补丁两部分：createEntityReference 创建时默认验证 XML Name；序列化时的 Name 校验仍只在严格模式启用，用于捕获创建后 nodeName 变异。默认序列化仍原样输出。

**本项目：** 普通解析路径不构造 EntityReference 节点，应用无 createEntityReference 或直接 nodeName 变异；此公告直接 API 向量未证明可达。不要把创建时默认修复误写成所有序列化默认修复。 来源：[仓库全文](https://github.com/xmldom/xmldom/security/advisories/GHSA-6gmq-8vp8-gcm6)；[0.8 修复提交](https://github.com/xmldom/xmldom/commit/6c3fb5ffeafe7901ec928ce9010988dd716c94a0)；[0.9 修复提交](https://github.com/xmldom/xmldom/commit/4664386e4f4d99d17b416a151dbe8323e245284b)。

## requireWellFormed 与 0.9 迁移的精确含义

[0.8.13 tag 源码](https://raw.githubusercontent.com/xmldom/xmldom/0.8.13/lib/dom.js) 与 [0.8.15 tag 源码](https://raw.githubusercontent.com/xmldom/xmldom/0.8.15/lib/dom.js) 都使用 var requireWellFormed = !!options && !!options.requireWellFormed，缺省为 false。在 0.8 维护线，API 参数位置必须按实际签名区分：

- XMLSerializer.serializeToString(node, isHtml, nodeFilter, options)：options 为 **第 4 参数**。
- Node.toString(isHtml, nodeFilter, options)：options 为 **第 3 参数**。

当前 [serializeNodeChildren](/Users/wfz/workspace/r2-webdav/src/webdav/xml.ts#L51) 对每个子节点执行 child.toString()，没有启用上述选项；[死属性存储/渲染](/Users/wfz/workspace/r2-webdav/src/webdav/xml.ts#L121) 继续复用序列化结果。将来整改应对这一个真实调用点采用正确参数位置并处理严格模式抛错，结合 XML 节点来源判断，而不能照搬公告示例中面向不同分支的参数位置。严格序列化也不是 HTML 清洗器或 DOM 节点语义白名单。

旧 0.8.13 已有 comment/PI data/doctype 字段的 opt-in 检查，不代表本项目已经启用；0.8.14/0.8.15 在同一严格分支扩充了名称检查。EntityReference 是“默认创建校验 + 可选序列化校验”的例外；四条 DoS 修复则独立于此选项。0.8.15 的结束标签补丁默认发 recoverable error，本项目现有错误数组会因此拒绝，单独使用默认 parser 的其他消费者仍会恢复。

[0.9.12 dom-parser.js](https://raw.githubusercontent.com/xmldom/xmldom/0.9.12/lib/dom-parser.js) 明确在 errorHandler 是对象时抛出 TypeError('errorHandler object is no longer supported, switch to onError!')；本项目 [当前配置](/Users/wfz/workspace/r2-webdav/src/webdav/xml.ts#L169) 正是对象。因此推荐首先在现有 0.8 维护线评审 0.8.15，再单独迁移 onError 回调语义与严格序列化接口。补核时 [package.json](/Users/wfz/workspace/r2-webdav/package.json#L23) 的 ^0.8.11 允许 0.8.15，但当时 [锁文件](/Users/wfz/workspace/r2-webdav/package-lock.json) 固定 0.8.13；修复实施阶段已完成真实升级和回归，将生产依赖改为 0.8.15，未采用 0.9.12。

另有应用自己的 [hasDavNamespaceDescendant](/Users/wfz/workspace/r2-webdav/src/webdav/xml.ts#L138) 递归。旧 0.8.13 的库遍历迭代修复与新 0.8.15 四条复杂度修复都不自动替换这个应用函数；深度预算/改为迭代仍是独立加固项，不新增伪造 CVE 或声称本轮完成了它。

## 超出旧十条的全面检索

核对 [全局包查询](https://api.github.com/advisories?ecosystem=npm&affects=%40xmldom%2Fxmldom&per_page=100) 23 条、[精确 0.8.13 查询](https://api.github.com/advisories?ecosystem=npm&affects=%40xmldom%2Fxmldom%400.8.13&per_page=100) 10 条、[仓库全部公开公告](https://api.github.com/repos/xmldom/xmldom/security-advisories?per_page=100) 24 条，而非只抓旧列表。所有查询返回 Link 无续页。23 条中，10 条命中、下列五条仅 0.9 分支、八条更早版本公告不命中。

| 额外 2026 公告                                                                            | 完整 scoped 范围             | 首个修复版 | 仓库公开 / 全局库公开（UTC）              |
| ----------------------------------------------------------------------------------------- | ---------------------------- | ---------- | ----------------------------------------- |
| [GHSA-jxjr-3g7g-3944](https://github.com/advisories/GHSA-jxjr-3g7g-3944) / CVE-2026-83617 | `= 0.9.11`                   | `0.9.12`   | 2026-08-21 22:50:14 / 2026-09-08 21:03:17 |
| [GHSA-3px3-54cx-rmw9](https://github.com/advisories/GHSA-3px3-54cx-rmw9) / CVE-2026-83609 | `>= 0.9.0, <= 0.9.11`        | `0.9.12`   | 2026-08-21 22:50:15 / 2026-09-08 21:02:33 |
| [GHSA-vr34-hp96-76pp](https://github.com/advisories/GHSA-vr34-hp96-76pp) / CVE-2026-83618 | `>= 0.9.10, <= 0.9.11`       | `0.9.12`   | 2026-08-21 22:50:14 / 2026-09-08 21:02:25 |
| [GHSA-6mj3-qw4j-hgrw](https://github.com/advisories/GHSA-6mj3-qw4j-hgrw) / CVE-2026-83612 | `>= 0.9.0-beta.1, <= 0.9.11` | `0.9.12`   | 2026-08-21 22:50:09 / 2026-09-08 20:59:54 |
| [GHSA-g53g-w8rj-fmg7](https://github.com/advisories/GHSA-g53g-w8rj-fmg7) / CVE-2026-83606 | `>= 0.9.0-beta.9, <= 0.9.10` | `0.9.11`   | 2026-08-12 19:51:36 / 2026-09-08 20:31:50 |

较早八条为下节六条，加 [GHSA-9pgh-qqpf-7wqj / CVE-2022-37616](https://github.com/advisories/GHSA-9pgh-qqpf-7wqj)（scoped <0.7.6、>=0.8.0 <0.8.3、=0.9.0-beta.1）及 [GHSA-5fg8-2547-mr8q / CVE-2021-32796](https://github.com/advisories/GHSA-5fg8-2547-mr8q)（scoped <0.7.0），均不命中 0.8.13。仓库比 scoped 查询多出的 [GHSA-h6q6-9hqw-rwfv / CVE-2021-21366](https://github.com/xmldom/xmldom/security/advisories/GHSA-h6q6-9hqw-rwfv) 仅旧 unscoped xmldom <=0.4.0，2021 年公告，不能计作本次新增。此处“无第十一条”仅为本日所读官方公开数据库结果，不包括未公开漏洞。

## 原报告六条历史修复也已补读全文

下表独立核对了此前仅凭安装包 CHANGELOG 提及的六条完整公告及仓库元数据。范围按包名完整列出；日期顺序为仓库 published / 全局 published / 全局 updated。它们不在当前十条集合内；旧安全选项的默认行为仍须单独判断。

| 历史 GHSA / CVE                                                                           | 精确受影响范围                                                                                                                                      | 首个 scoped 补丁版本               | 三个日期（UTC）                                                 |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------- |
| [GHSA-wh4c-j3r5-mjhp](https://github.com/advisories/GHSA-wh4c-j3r5-mjhp) / CVE-2026-34601 | `xmldom`: `<= 0.6.0`<br>`@xmldom/xmldom`: `< 0.8.12`<br>`@xmldom/xmldom`: `>= 0.9.0, < 0.9.9`                                                       | `0.8.12` / `0.9.9`                 | 2026-03-29 20:03:08 / 2026-04-01 00:19:06 / 2026-04-24 23:17:46 |
| [GHSA-2v35-w6hq-6mfw](https://github.com/advisories/GHSA-2v35-w6hq-6mfw) / CVE-2026-41673 | `@xmldom/xmldom`: `< 0.8.13`<br>`@xmldom/xmldom`: `>= 0.9.0, < 0.9.10`<br>`xmldom`: `<= 0.6.0`                                                      | `0.8.13` / `0.9.10`                | 2026-04-18 11:39:22 / 2026-04-22 20:23:57 / 2026-05-08 20:10:22 |
| [GHSA-j759-j44w-7fr8](https://github.com/advisories/GHSA-j759-j44w-7fr8) / CVE-2026-41672 | `@xmldom/xmldom`: `< 0.8.13`<br>`@xmldom/xmldom`: `>= 0.9.0, < 0.9.10`<br>`xmldom`: `<= 0.6.0`                                                      | `0.8.13` / `0.9.10`                | 2026-04-18 11:39:08 / 2026-04-22 20:16:07 / 2026-05-08 20:10:07 |
| [GHSA-x6wf-f3px-wcqx](https://github.com/advisories/GHSA-x6wf-f3px-wcqx) / CVE-2026-41675 | `@xmldom/xmldom`: `< 0.8.13`<br>`@xmldom/xmldom`: `>= 0.9.0, < 0.9.10`<br>`xmldom`: `<= 0.6.0`                                                      | `0.8.13` / `0.9.10`                | 2026-04-18 11:39:20 / 2026-04-22 20:17:58 / 2026-05-08 20:10:14 |
| [GHSA-f6ww-3ggp-fr8h](https://github.com/advisories/GHSA-f6ww-3ggp-fr8h) / CVE-2026-41674 | `@xmldom/xmldom`: `< 0.8.13`<br>`@xmldom/xmldom`: `>= 0.9.0, < 0.9.10`<br>`xmldom`: `<= 0.6.0`                                                      | `0.8.13` / `0.9.10`                | 2026-04-18 11:39:21 / 2026-04-22 20:19:12 / 2026-05-08 20:10:17 |
| [GHSA-crh6-fp67-6883](https://github.com/advisories/GHSA-crh6-fp67-6883) / CVE-2022-39353 | `xmldom`: `<= 0.6.0`<br>`@xmldom/xmldom`: `< 0.7.7`<br>`@xmldom/xmldom`: `>= 0.8.0, < 0.8.4`<br>`@xmldom/xmldom`: `>= 0.9.0-beta.1, < 0.9.0-beta.4` | `0.7.7` / `0.8.4` / `0.9.0-beta.4` | 2022-10-29 22:03:00 / 2022-11-01 17:29:11 / 2023-03-31 16:06:26 |

- CDATA（CVE-2026-34601）：0.8.12 / 0.9.9 创建时拒绝非法终止符，序列化时对变异后的内容默认拆段，0.8.13 已包含这部分默认行为。
- 深树遍历（CVE-2026-41673）：0.8.13 / 0.9.10 的库级递归遍历改为迭代；不等于修复应用自己的递归。
- comment、PI data、DocumentType 部分字段（CVE-2026-41672 / 41674 / 41675）：0.8.13 / 0.9.10 提供 requireWellFormed:true 路径的检查；缺省序列化保留兼容行为，本项目尚未启用。名称类注入又由本次新补丁扩充，不能混淆成同一条 CVE。
- CVE-2022-39353：0.8.4 等分支补丁修复非良构 DOM 插入，已在当前 0.8.13 中；不是本轮 2026 新漏洞。

## 证据保存、边界与后续动作

原始数据与下载元数据保存在 [.tmp/security-audit/online-xmldom](/Users/wfz/workspace/r2-webdav/.tmp/security-audit/online-xmldom/)：完整公告/仓库全集、10 条 CVE、4 条 NVD、registry packument/四个版本 manifest/dist-tags、release 列表、tag 源码和 17 个官方 .patch，均带 URL、抓取时间、HTTP 状态或配套 meta。便于复查的索引是 [fetch-index.json](/Users/wfz/workspace/r2-webdav/.tmp/security-audit/online-xmldom/fetch-index.json)、[verification-fetch-index.json](/Users/wfz/workspace/r2-webdav/.tmp/security-audit/online-xmldom/verification-fetch-index.json)、[patch-fetch-index.json](/Users/wfz/workspace/r2-webdav/.tmp/security-audit/online-xmldom/patch-fetch-index.json)；[仓库与全局描述对比](/Users/wfz/workspace/r2-webdav/.tmp/security-audit/online-xmldom/description-comparison.json) 留下了 hardening 更新尚未同步的证据。

唯一未成功的五次请求是 GitHub tag-ref API 的匿名配额 403（API rate limit exceeded），并非网络故障或安全拒绝；未提升权限、读取凭据或绕过拒绝。实际 tag 文件、release、manifest、修复 commit 的官方内容均成功读取，因此不影响上述版本/补丁/行为结论。独立 tag-ref 对象未核实，不声称已认证 Git tag 对象或 npm 制品签名。

本次只新增此研究文档及临时证据；未改源码、[package.json](/Users/wfz/workspace/r2-webdav/package.json)、[锁文件](/Users/wfz/workspace/r2-webdav/package-lock.json) 或两份既有总报告；未执行公告攻击、下载/执行新 npm 包或远程压力测试。后续由主线程合并结论，再另行实施兼容升级、严格序列化与资源预算加固，并运行正常回归。当前结果支持把四条认证后可达解析复杂度风险列为优先修复项，同时将构造型注入、strict 选项、[Hardening] 条目及应用递归分别写清前提。
