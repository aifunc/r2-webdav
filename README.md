# r2-webdav

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/abersheeran/r2-webdav)

Use Cloudflare Workers to provide a WebDav interface for Cloudflare R2.

Currently the server advertises WebDAV Class 1 and Class 2 (LOCK/UNLOCK) support.

## Project Structure

- `src/index.ts`: Cloudflare Worker 入口 shim，转发到 `src/app/worker.ts`。
- `src/app/`: 顶层入口与方法分发，包含 `worker.ts` 和 `dispatch.ts`。
- `src/domain/`: 领域能力模块，按职责拆分为鉴权、路径、锁、目录 sidecar 和 R2 存储。
- `src/webdav/http/`: HTTP 层处理器，拆分为共享逻辑、内容读取和写入变更处理。
- `src/webdav/methods/`: WebDAV 方法处理器，拆分为属性、传输和锁相关模块。
- `src/webdav/xml.ts` / `src/webdav/responses.ts`: XML 渲染和协议响应工厂。
- `src/shared/`: 纯常量、类型和通用转义工具。
- `tests/`: 轻量 Node 单测，覆盖鉴权、R2 存储、目录 sidecar 和 COPY/MOVE 路径安全回归。
- `scripts/wrangler-dev.sh`: 本地开发包装脚本，适配 Docker 和受限环境。

## Usage

Change wrangler.toml to your own.

```toml
[[r2_buckets]]
binding = 'bucket' # <~ valid JavaScript variable name, don't change this
bucket_name = 'webdav'
```

Then use wrangler to deploy.

```bash
wrangler deploy

wrangler secret put USERNAME
wrangler secret put PASSWORD
```

## Directory Metadata Model

目录元数据不再依赖 R2 里的同名目录标记对象。Worker 会把目录死属性和锁状态存进 `.__sidecar__/<path>.json` 这样的内部 sidecar，对接第三方 R2 客户端时可以避免“同名文件 + 同名文件夹”的冲突。

默认内部保留前缀是 `.__sidecar__`。WebDAV 请求不能直接读写这个前缀，`COPY` / `MOVE` 到这个前缀下也会被拒绝。你也可以通过 `wrangler.toml` 里的 `SIDECAR_PREFIX` 改成别的名字。

```toml
[vars]
SIDECAR_PREFIX = ".__sidecar__"
```

如果你的存储桶里还保留旧的目录标记对象，在和其他 R2 客户端混用前先迁移：

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

迁移脚本通过 Wrangler 平台代理访问配置好的 R2 绑定，并使用当前 `SIDECAR_PREFIX` 配置生成 sidecar 路径；它会优先复用或校验已有 sidecar，不会盲目覆盖，只有在写入或校验成功后才删除旧标记对象。

## Development

With `wrangler`, you can run and deploy your Worker with the following commands:

```sh
# install dependencies
$ npm ci

# run your Worker in an ideal development workflow (with a local server, file watcher & more)
$ npm run dev

# run TypeScript type checks only
$ npm run typecheck

# run typecheck and formatting checks
$ npm run check

# run lightweight unit tests
$ npm run test:unit

# deploy your Worker globally to the Cloudflare network (update your wrangler.toml file for configuration)
$ npm run deploy
```

`npm run dev` now wraps Wrangler with a project-local `XDG_CONFIG_HOME` and binds to `0.0.0.0`, which avoids local config permission issues and works more reliably in Docker-based development environments.
Development credentials should be stored in a local `.dev.vars` file with `USERNAME` and `PASSWORD`.
Temporary build output stays under `.tmp/`, and `.prettierignore` excludes that directory so `npm run check` still passes after running unit tests.

## Test

Use `npm run test:unit` for fast local regression checks, and [litmus](https://github.com/notroj/litmus) for WebDAV integration testing.

```bash
litmus -k http://127.0.0.1:8787/ <user> <pass>
```

Current unit tests cover auth parsing, storage behavior, directory sidecars, and copy/move safety guards.
GitHub Actions runs the `basic`, `copymove`, `props`, and `locks` litmus suites against `wrangler dev --local`.
The `http` suite is currently excluded because local Workers runs still time out on the interim `Expect: 100-continue` response check.
