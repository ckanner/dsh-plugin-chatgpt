# 实验性 Web bridge：协议与持久化

[English](web-bridge-contract.md) | 中文

本阶段实现 [stock DSH sidecar 设计](design/chatgpt-web-sidecar.zh.md)中的协议与持久化基础。正常安装后的 `chatgpt` provider 继续使用 SIWC。**本阶段没有生产用 Chrome transport，也不会出现可选择的 Web 模型。** 只有开发者明确提供 `WebPageTransport` 实现后，bridge 才会启动。测试注入离线页面 fixture，不访问 ChatGPT，也不使用账号。

## 已实现的边界

实验性包入口为 `dsh-plugin-chatgpt/experimental/web-bridge`，导出 engine、HTTP server、薄客户端、公共契约与请求规范化函数。导入该入口不会启动进程、打开 Chrome、注册模型或修改 DSH profile。

| 组件 | 职责 |
| --- | --- |
| `request.ts` | 在异步工作之前同步复制原始公共 `GenerateOptions`，包括持久消息 ID 与 `toolHistory`。 |
| `protocol.ts` | 限制 JSON、规范化语义身份、验证命名空间/receipt，以及完整响应和参数 schema。 |
| `journal.ts` | 仅属主可读的持久快照、文件和父目录 fsync、物理 profile 排他锁，以及固定 journal 绑定。 |
| `engine.ts` | 串行执行页面操作、保留请求 tombstone、阻止不确定提交，并且只认领一次可执行响应。 |
| `server.ts` | 回环鉴权、私有客户端 lease、有限 SSE，以及检查/证据核对接口。 |
| `client.ts` | 验证已鉴权的绑定和整个 SSE 响应，再输出公共 DSH chunk 并闭合 iterator。 |

模型契约仅接受 `gpt-6-pro-web` 和 `pro` effort。这是协议身份，不代表模型已可用。完整的既有 SIWC 模型目录与调用路径继续位于正常 provider 入口。

## 请求与响应规则

哈希覆盖 installation、provider 路由、物理 profile 绑定、account 绑定、session、purpose、消息身份、顺序完整的正文、有效 system 指令、当前与历史工具定义、controls、附件版本和 parent receipt；排除传输 lease/attempt ID。服务端在查找请求前重新计算哈希。提供的 parent receipt 必须与已哈希的 assistant 历史和本地 journal 证据一致。

普通调用要求 session ID 和每条输入消息的稳定 ID。压缩调用允许在有身份的源消息后追加一条没有身份的用户总结指令。会话标题使用语义输入，而非生产者新生成的 wrapper UUID。外来的 SIWC replay state 不会被转发。分叉会话不能接管来源会话的 Web receipt。

由 receipt 绑定的精确追加，只有在 parent 仍是该 generation 最新已接纳请求时，才可续接当前 generation。前缀、指令、工具历史改变，或从旧 parent 建立分支，都会使用新 generation。每次提交前，transport 仍须准备并核验实际页面；journal 中的 generation ID 本身不证明活跃页面一致。

注入的页面返回以下完整 envelope：

```json
{
  "version": 1,
  "complete": true,
  "blocks": [
    { "type": "text", "text": "A complete answer." }
  ]
}
```

工具 block 使用 `type: "tool-call"`、当前响应内的 `id`、已声明的 `name` 和 JSON 字符串 `arguments`。bridge 通过 Ajv 验证 JSON Schema draft-07 参数，不进行类型强制转换或默认值插入；提交前拒绝不支持的 schema 和外部引用，拒绝重复 ID，并将调用 ID 限定到当前响应的命名空间。辅助 purpose 不允许返回工具调用。成功投递前，完整 block 与摘要已经持久化。

有限 SSE 响应包含一个携带完整 `WebResponse` 的 `response` 事件，随后是匹配的 `finish` 事件和 EOF。客户端验证这三个边界后才输出 DSH chunk，不伪造 reasoning 或 token usage。工具响应以 `finish.reason.kind = "tool-calls"` 结束；真正的 stock host 此后才执行工具，并在下一次 provider 请求中回传结果。

## 持久化与所有权

首次显式 setup 向 `openWebBridge` 提供 `directory`、`profileDirectory`、经过验证的 `WebBinding` 和 `initialize: true`。后续启动必须复用相同绑定和证据。实现会在物理 profile 中持久保存 marker，指定其 journal。改变 journal 路径、account 或 installation，不能悄悄隐藏先前的不确定状态。证据缺失或损坏会拒绝继续，即使再次请求初始化也不例外。

状态顺序为 `accepted → preparing → submit_intent → submitted → observing → completed`。只有 `submit_intent` 快照完成原子替换和 fsync 后，才允许调用 `transport.submit()`。该边界后的失败或取消保守地成为 `uncertain`；整个物理 profile 会拒绝新提交，直到只读证据核对确认终态。Send 前中断的请求保留终态 tombstone，不会自动重新开始。

相同精确 key 的两个调用方共享一次页面操作。已完成的纯文本可以从缓存返回。含工具的响应先持久化一个 `delivery-intent`，指定唯一的 `clientLeaseId + deliveryAttemptId`。之后任何请求若试图重新获取这份缓存工具响应，都会得到 `WEB_DELIVERY_CLAIMED`，同一个 owner 重连也一样。丢失连接不会转移所有权。续轮要求精确匹配的 receipt/正文，以及每个工具调用的一份对应结果；缺失、重复或冲突的结果不能授权再次调用工具。

`recover` 只读取页面证据并核对 journal。`discard` 保留 tombstone，不清除未知浏览器结果。检查接口中的数据不是执行其中工具 block 的授权。receipt 只证明本 bridge 记录了什么，不是宿主持久化 ACK，也不是工具执行证明。

锁通过真实物理 profile 和 journal 下的独占目录实现，包含随机 owner token，绝不只凭陈旧 PID 回收。正常关闭会等待所有 transport 操作结束后才释放锁。进程硬崩溃后，操作者必须先确认没有 bridge 或其浏览器操作仍在运行，检查证据，再人工处理残留锁。这里特意不提供自动抢锁命令。持久化实现已在 POSIX 上验证；本阶段不承诺 Windows 目录 fsync 行为。

快照 journal 上限为 64 MiB，没有自动删除或压缩；达到上限后停止接纳请求。这一有界基础实现优先保留证据，生产用保留/归档策略属于后续工作。

## HTTP 与客户端生命周期

`startWebBridgeServer({ engine })` 监听 `127.0.0.1` 的临时端口，生成私有 launch bearer token。所有 endpoint 都要求该 token。Host 必须精确匹配监听地址；拒绝浏览器 Origin、含糊凭据、重定向、编码后的正文和非 JSON POST。正文/响应上限为 1 MiB、嵌套 64 层、header 16 KiB、读取请求正文 10 秒。模型操作本身不受该 10 秒截止限制。

`WebBridgeClient({ url, token, expectedBinding, errorFactory })` 检查握手并注册自己的私有 lease。`stream(options)` 立即复制调用方输入，早于 iterator 推进或连接建立。心跳只续租这一 lease。`dispose()` 释放自己的 lease 并取消自己拥有的工作；其他客户端的 server/工作继续运行。host adapter 提供创建公共 `LlmError` 的 `errorFactory`。真实宿主 fixture 展示了该公共接入方式，不需要 DSH 补丁。

| Endpoint | 用途 |
| --- | --- |
| `GET /health` | 已鉴权的实验性 instance/binding 握手。 |
| `POST /v1/clients` | 使用 `{}` 注册私有 lease；默认 TTL 为 60 秒。 |
| `POST /v1/clients/:id/heartbeat` | 使用 `{}` 只续租该 lease。 |
| `DELETE /v1/clients/:id` | 只释放该 lease。 |
| `POST /v1/turns` | 接纳精确规范化请求，并投递一份有限响应。 |
| `GET /v1/turns/:id?sessionId=...` | 检查该 lease 已加入的请求。 |
| `POST /v1/turns/:id/cancel` | 只取消初始提交客户端拥有的工作。 |
| `POST /v1/turns/:id/recover` | 核对只读页面证据。 |
| `POST /v1/turns/:id/discard` | 保留显式 discard tombstone。 |

lease 范围内的请求携带 `X-Web-Client-Lease`。turn 控制 POST 使用 `{ "sessionId": "..." }`。新 lease 不能仅凭 session ID 获得控制权限：必须先重新接纳完全相同的哈希请求。即使回复为 `WEB_UNCERTAIN` 或 `WEB_DELIVERY_CLAIMED`，也会登记其参与身份；这不会重发页面 prompt，也不会授权工具回放。turn ID 是确定性的：`turn-` 加请求 SHA-256 的十六进制摘要。只有原始接纳客户端能取消底层操作。

页面 transport 接口刻意保持狭窄：`prepare` 只读，`submit` 是唯一变更边界，`observe` 提供完整 envelope，可选 `recover` 提供只读终态证据。后续 Chrome transport 必须先为 Project 创建、上传和清理加入各自持久化 intent/证据，才能执行这些变更。

## 尚不可用的部分

尚未实现真实 Chrome 发现/启动、账号登录与核验、GPT-6/Pro 选择、私有 Project 隔离、DOM 响应提取、setup/recovery UI、discovery/daemon 启动及浏览器进程清理。这些离线测试中由调用方提供的 `accountBinding`，不等于真实账号核验。

图片、文件和附件传输会被拒绝。`temperature`、`maxTokens` 和 `stop` 会被拒绝，而非悄悄忽略。stock 压缩和标题生产者会请求输出上限，因此后续 setup 在启用 Web 前必须明确配置支持这些控制项的辅助 provider/model。本阶段不提供 Web usage 估算、可强制执行的硬预算或 Flywheel 任务完成证明。Flywheel 接入将跟随真实浏览器 transport 和 setup 验收推进。

## 复现验证

```sh
npm ci --ignore-scripts
npm run test:web
npm run typecheck
npm run build
```

真实宿主 gate 使用已发行 DSH `dsh-v0.2.2-rc.5` commit `9c2670d3bce5275e0d1610272958121af87787bb`。在未修改的 checkout 中，安装与 Node 匹配的 headers 后运行 `node native/system/scripts/build.ts --host-addon-only`。提供其正常依赖，或按 `.github/workflows/web-contract.yml` 安装隔离的固定版本依赖，再运行：

```sh
npm run verify:web-agent-loop -- /path/to/deepseek-harness --deps /path/to/isolated-host-dependencies
```

脚本打包真正的 stock AgentLoop、LLM runtime、BlockAssembler、native tool executor、JSONL persistence 和 checkpoint policy。执行前后检查选定 commit 和宿主 tracked 文件未改变；只有页面 transport 使用 fixture。CI 和 release 共用 Node 24 的 Linux gate，普通 bridge 测试同时运行在支持的 Node 22 和 24 系列上。

| 真实宿主场景 | 工具执行次数 | 页面提交次数 | 宿主请求尝试 |
| --- | ---: | ---: | ---: |
| 正常工具闭环 | 1 | 2 | 2 |
| 完成文本在交给 host 前丢失，随后重试 | 1 | 2 | 3 |
| 工具 block 已曝光但 finish 丢失，随后重试 | 0 | 1 | 2 |
| 两个客户端并发加入同一工具响应 | 1 | 2 | 2 |

这些检查验证 stock host 边界，包括工具执行前的 assistant checkpoint，以及下一次请求中的 receipt/结果；它们不证明真实 ChatGPT 可用性或网页行为。
