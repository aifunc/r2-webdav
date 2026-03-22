# r2-webdav

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/abersheeran/r2-webdav)

Use Cloudflare Workers to provide a WebDav interface for Cloudflare R2.

Currently the server advertises WebDAV Class 1 and Class 2 (LOCK/UNLOCK) support.

## Project Structure

- `src/index.ts`: Cloudflare Worker 入口 shim，转发到 `src/app/worker.ts`。
- `src/app/`: 入口编排与方法分发，只负责鉴权、CORS 和路由。
- `src/domain/`: 领域能力模块，如鉴权、路径、锁和 R2 存储逻辑。
- `src/webdav/`: WebDAV 协议处理器、XML 解析/渲染和协议响应工厂。
- `src/shared/`: 纯常量、类型和通用转义工具。
- `tests/`: 轻量 Node 单测，覆盖鉴权、路径安全和递归传输等回归场景。
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

## Development

With `wrangler`, you can run and deploy your Worker with the following commands:

```sh
# install dependencies
$ npm ci

# run your Worker in an ideal development workflow (with a local server, file watcher & more)
$ npm run dev

# run typecheck and formatting checks
$ npm run check

# run lightweight unit tests
$ npm run test:unit

# deploy your Worker globally to the Cloudflare network (update your wrangler.toml file for configuration)
$ npm run deploy
```

`npm run dev` now wraps Wrangler with a project-local `XDG_CONFIG_HOME` and binds to `0.0.0.0`, which avoids local config permission issues and works more reliably in Docker-based development environments.
Development credentials should be stored in a local `.dev.vars` file with `USERNAME` and `PASSWORD`.

## Test

Use [litmus](https://github.com/notroj/litmus) for WebDAV integration testing, and `npm run test:unit` for fast local regression checks.

```bash
litmus -k http://127.0.0.1:8787/ <user> <pass>
```

GitHub Actions runs the `basic`, `copymove`, `props`, and `locks` litmus suites against `wrangler dev --local`.
The `http` suite is currently excluded because local Workers runs still time out on the interim `Expect: 100-continue` response check.
