# r2-webdav

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/abersheeran/r2-webdav)

使用 Cloudflare Workers 为 Cloudflare R2 提供 WebDAV 接口。

支持 WebDAV Class 1 和 Class 2（LOCK/UNLOCK）。文件 `GET` / `HEAD` 返回 `ETag` 和 `Last-Modified`；文件 `PUT`、`DELETE`、`PROPPATCH`、`COPY`、`MOVE` 支持 `If-Unmodified-Since`。

## 相比最初版本新增的能力

| 能力           | 最初版本                           | 当前版本                                                                                                                            |
| -------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 目录元数据存储 | 依赖 R2 里的同名目录标记对象       | 使用 sidecar 保存目录死属性和锁，避免“同名文件 + 同名文件夹”冲突                                                                    |
| 多用户鉴权     | 仅支持单个 `USERNAME` / `PASSWORD` | 支持 `AUTH_USERS` 多行 `username:password`，并兼容旧单用户配置                                                                      |
| 文件并发控制   | 缺少明确的版本头和条件写入支持     | 文件 `GET` / `HEAD` 返回 `ETag` / `Last-Modified`，文件 `PUT` / `DELETE` / `PROPPATCH` / `COPY` / `MOVE` 支持 `If-Unmodified-Since` |
| 本地开发适配   | 直接依赖本机 Wrangler 配置         | `npm run dev` 使用项目级 `XDG_CONFIG_HOME` 并绑定 `0.0.0.0`，更适合 Docker 环境                                                     |

## 项目结构

- `src/index.ts`: 入口 shim，转发到 `src/app/worker.ts`
- `src/app/`: 顶层入口与方法分发
- `src/domain/`: 鉴权、路径、锁、目录 sidecar、R2 存储
- `src/webdav/`: HTTP/WebDAV 方法处理、XML 渲染、响应工厂
- `src/shared/`: 常量、类型、通用工具
- `tests/`: 轻量回归测试
- `scripts/`: 本地开发和迁移脚本

## 快速开始

先配置 `wrangler.toml`：

```toml
[[r2_buckets]]
binding = "bucket"
bucket_name = "webdav"

[vars]
SIDECAR_PREFIX = ".__sidecar__"
```

部署时推荐使用多用户密钥：

```bash
wrangler deploy

wrangler secret put AUTH_USERS
```

`AUTH_USERS` 使用简单文本格式，每行一组账号，格式为 `username:password`，例如：

```text
alice:secret-1
bob:secret-2
```

未配置 `AUTH_USERS` 时，仍会回退到旧的 `USERNAME` / `PASSWORD`。

## 目录与迁移

目录死属性和锁状态保存在 `.__sidecar__/<path>.json` 这样的内部 sidecar 中，不再依赖 R2 里的同名目录标记对象。这样可以避免第三方 R2 客户端场景下的“同名文件 + 同名文件夹”冲突。

如果你的存储桶里还有旧目录标记对象，先开启远程 R2 绑定再迁移：

```toml
[[r2_buckets]]
binding = "bucket"
bucket_name = "webdav"
remote = true
```

```bash
node scripts/migrate-directory-sidecars.mjs --dry-run
node scripts/migrate-directory-sidecars.mjs
```

## 开发

```sh
npm ci
npm run dev
npm run typecheck
npm run check
npm run test:unit
npm run deploy
```

`npm run dev` 会使用项目内 `XDG_CONFIG_HOME` 并绑定 `0.0.0.0`，适合 Docker 环境。开发时建议在 `.dev.vars` 中配置：

```text
AUTH_USERS="alice:secret-1
bob:secret-2"
```

单用户场景仍可继续使用 `USERNAME` 和 `PASSWORD`。

## 测试

本地快速回归使用 `npm run test:unit`，WebDAV 集成验证建议使用 [litmus](https://github.com/notroj/litmus)：

```bash
litmus -k http://127.0.0.1:8787/ <user> <pass>
```

当前单测主要覆盖鉴权、目录 sidecar、存储行为和 COPY/MOVE 安全逻辑。GitHub Actions 还会跑 `basic`、`copymove`、`props`、`locks` 四组 litmus 测试；`http` 套件仍因本地 Workers 的 `Expect: 100-continue` 限制被排除。
