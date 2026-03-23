# r2-webdav

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/abersheeran/r2-webdav)

使用 Cloudflare Workers 为 Cloudflare R2 提供 WebDAV 接口。

当前服务声明支持 WebDAV Class 1 和 Class 2（LOCK/UNLOCK）。

## 项目结构

- `src/index.ts`: Cloudflare Worker 入口 shim，转发到 `src/app/worker.ts`。
- `src/app/`: 顶层入口与方法分发，包含 `worker.ts` 和 `dispatch.ts`。
- `src/domain/`: 领域能力模块，按职责拆分为鉴权、路径、锁、目录 sidecar 和 R2 存储。
- `src/webdav/http/`: HTTP 层处理器，拆分为共享逻辑、内容读取和写入变更处理。
- `src/webdav/methods/`: WebDAV 方法处理器，拆分为属性、传输和锁相关模块。
- `src/webdav/xml.ts` / `src/webdav/responses.ts`: XML 渲染和协议响应工厂。
- `src/shared/`: 纯常量、类型和通用转义工具。
- `tests/`: 轻量 Node 单测，覆盖鉴权、R2 存储、目录 sidecar 和 COPY/MOVE 路径安全回归。
- `scripts/wrangler-dev.sh`: 本地开发包装脚本，适配 Docker 和受限环境。

## 使用方式

先按你的环境修改 `wrangler.toml`。

```toml
[[r2_buckets]]
binding = 'bucket' # <~ 需要是合法的 JavaScript 变量名，不要改
bucket_name = 'webdav'
```

然后使用 Wrangler 部署：

```bash
wrangler deploy

wrangler secret put USERNAME
wrangler secret put PASSWORD
```

## 目录元数据模型

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

## 开发

使用 `wrangler` 时，可以通过下面这些命令完成本地开发和部署：

```sh
# 安装依赖
$ npm ci

# 启动本地 Worker（带本地服务、监听等开发能力）
$ npm run dev

# 仅运行 TypeScript 类型检查
$ npm run typecheck

# 运行类型检查和格式检查
$ npm run check

# 运行轻量单元测试
$ npm run test:unit

# 部署到 Cloudflare 全球网络（部署前先更新 wrangler.toml 配置）
$ npm run deploy
```

`npm run dev` 现在会用项目内的 `XDG_CONFIG_HOME` 包装 Wrangler，并绑定到 `0.0.0.0`，这样可以避免本地配置权限问题，也更适合 Docker 开发环境。
开发凭据应放在本地 `.dev.vars` 文件中，包含 `USERNAME` 和 `PASSWORD`。
临时构建产物会落到 `.tmp/`，并且 `.prettierignore` 已排除该目录，因此运行单测后 `npm run check` 仍然可以通过。

## 测试

本地快速回归建议使用 `npm run test:unit`，WebDAV 集成验证建议使用 [litmus](https://github.com/notroj/litmus)。

```bash
litmus -k http://127.0.0.1:8787/ <user> <pass>
```

当前单测主要覆盖鉴权解析、存储行为、目录 sidecar，以及 COPY/MOVE 的安全保护逻辑。
GitHub Actions 会基于 `wrangler dev --local` 运行 `basic`、`copymove`、`props` 和 `locks` 四组 litmus 测试。
`http` 测试套件目前仍被排除，因为本地 Workers 运行时在 `Expect: 100-continue` 的中间响应检查上依然会超时。
