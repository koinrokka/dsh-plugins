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
