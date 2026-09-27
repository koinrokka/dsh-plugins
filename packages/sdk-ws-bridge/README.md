# @koinrokka/dsh-sdk-ws-bridge

把 dsh SDK JSON-RPC 从 stdio 搬到 WebSocket,带 token 鉴权。koinrokka 平台
(platform server)经它连接 locker 容器内的 dsh 运行时。ADR 0008。

## 安装

```sh
dsh plugin --profile <sdk-profile> add @koinrokka/dsh-sdk-ws-bridge
```

bundle 的 `cordis.patch.yml` 会自动:禁用 stdio server 行(`sdk-jsonrpc-server`),
插入 bridge 行(默认 `0.0.0.0:7800`)。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `port` | `7800` | 监听端口 |
| `host` | `127.0.0.1` | 容器内用 `0.0.0.0`(patch 已配好) |
| `token` | env `KOINROKKA_BRIDGE_TOKEN` | **必填,fail closed**:没有就拒绝启动 |
| `maxTokensAsSuccess` | `false` | 透传给 stdio server 同名选项 |

鉴权:`Authorization: Bearer <token>` 头或 `?token=` 查询参数。失败 close code `4401`。

## 线协议约定

- **一条 WebSocket 消息 = 一个 JSON-RPC 帧**(不需要换行符;适配层内部处理)
- `initialize` **必须带 `cwd` 参数**(dsh server 直接 `resolve(params.cwd)`,缺了报错)
- **单活跃连接**:新连接通过鉴权后驱逐旧连接(平台重连语义简单)
- `shutdown`:优雅关闭该连接并回收其 SDK agents,**不退出进程**——容器生命周期
  归平台管,这与 stdio server 的"shutdown=进程退出"语义**有意不同**
- 30s 心跳 ping,防 VPC 半开连接

## 开发

```sh
pnpm install && pnpm build && pnpm test
```

单元测试覆盖:WS↔流适配往返、fail-closed、鉴权门。E2E(真实 dsh 握手)流程见
工作区 `docs/decisions/0008-sdk-bridge.md`。
