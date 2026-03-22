# Repository Guidelines

## Project Structure & Module Organization

本仓库是一个使用 TypeScript 编写的 Cloudflare Worker WebDAV 服务。`src/index.ts` 是 Worker 入口 shim，真实入口在 `src/app/worker.ts`，方法分发在 `src/app/dispatch.ts`。领域能力收敛在 `src/domain/`，包括鉴权、路径、锁和 R2 存储；协议相关代码位于 `src/webdav/`，包括 HTTP/WebDAV handlers、XML 解析与协议响应；纯常量、类型和转义工具位于 `src/shared/`。轻量回归测试放在 `tests/`，本地开发包装脚本位于 `scripts/wrangler-dev.sh`。

## Build, Test, and Development Commands

使用 `npm ci` 安装依赖。使用 `npm run dev` 或 `npm start` 启动本地 Worker；脚本会自动设置项目级 `XDG_CONFIG_HOME` 并绑定 `0.0.0.0`，适合 Docker 环境。使用 `npm run check` 运行 `tsc --noEmit` 和 Prettier 校验。使用 `npm run test:unit` 执行 Node 单测。需要集成验证时，先启动本地服务，再运行 `litmus -k http://127.0.0.1:8787/ <user> <pass>`。部署命令为 `npm run deploy`。

## Coding Style & Naming Conventions

遵循现有 TypeScript 风格：制表符缩进、LF、UTF-8、单引号、分号。格式以 Prettier 为准。类型和接口使用 PascalCase，如 `Env`；函数使用 camelCase，如 `parseDestinationPath`；常量使用 UPPER_SNAKE_CASE，如 `MAX_LOCK_TIMEOUT`。处理分支规则、状态映射或命令分派时，优先采用数据驱动编程，使用查表法让数据与逻辑分离，避免在主流程堆叠大量 `if/else`。同时应尽量减少不必要的中间变量、中间常量和中间函数；如果一个值或一小段逻辑只在局部使用，直接内联更清晰，就不要为了抽象而额外提取。

## Testing Guidelines

优先先跑 `npm run test:unit` 做快速回归，再跑 `npm run check`。涉及请求处理、COPY/MOVE 路径安全、锁、鉴权或 XML 生成时，应补充或更新 `tests/` 中的最小回归用例。GitHub Actions 会运行 `basic`、`copymove`、`props`、`locks` 四组 `litmus` 测试；本地 `http.expect100` 仍会因 Workers 本地实现限制超时，这不是新的功能回归。

## Commit & Pull Request Guidelines

历史提交倾向于简短、祈使式主题，常见 `fix:`、`feat:`、`refactor:` 前缀。每次提交应聚焦单一行为变化，例如 `fix: reject move to ancestor collection`。PR 需要写明行为变化、相关 issue、配置影响，以及已执行的验证命令，例如 `npm run test:unit`、`npm run check` 和 `litmus` 结果。

## Security & Configuration Tips

不要提交真实的 `USERNAME`、`PASSWORD`、`.dev.vars` 或 Cloudflare 凭据。修改 `wrangler.toml` 时，保持 `bucket` 绑定名称与代码中的 `Env.bucket` 一致。新增本地脚本或测试产物时，确认临时目录继续落在 `.tmp/`，不要把生成文件带入版本库。
