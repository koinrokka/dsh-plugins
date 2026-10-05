> **本仓已归档(2026-10):全部代码与历史已并入 monorepo [koinrokka/koinrokka](https://github.com/koinrokka/koinrokka)(platform/ + runtime/ + plugins/ 三目录,ADR 0027/0032)。此仓只读保留作历史凭证,请勿在此提 issue/PR。**
>
> **Archived:** everything here (code + full git history) now lives in the [koinrokka/koinrokka](https://github.com/koinrokka/koinrokka) monorepo. This repository is kept read-only for reference.

# koinrokka/dsh-plugins

koinrokka 的 dsh (DeepSeek Harness) 扩展包集合。架构决策见工作区 `../docs/decisions/`。

## 包

| 包 | 作用 | ADR |
|---|---|---|
| `@koinrokka/dsh-sdk-ws-bridge` | 把 dsh SDK JSON-RPC 从 stdio 搬到 WebSocket + token 鉴权 | 0008 |

## 纪律

- 插件只 import dsh 的文档化导出(seam/协议/服务),禁止 import 内部模块
- peerDependencies 声明共享实例;自研依赖进 dependencies
- 改动前读 `../AGENTS.md` 与相关 ADR

## 开发

```sh
pnpm install && pnpm build && pnpm test
```
