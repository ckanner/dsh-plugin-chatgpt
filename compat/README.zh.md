# DSH 宿主兼容契约

[English](README.md) | 中文

本目录提供 DeepSeek Harness 的源码兼容候选补丁。Web Provider 需要这些公开宿主扩展；只把 ChatGPT 插件装入未经修改的 DSH 桌面端或 SDK，并不会增加这些接口。插件检查运行时能力标志，缺少时拒绝 Web 调用。现有的 Sign in with ChatGPT 传输与这个需要显式启用的 Web 能力相互独立。

## 精确源码与安装边界

补丁针对 `deepseek-ai/deepseek-harness` 提交 `ca33fd6843b205e279c7ccb6cb73a472c78f5760`，其包版本为 `0.2.2-rc.4`。补丁不修改 DSH 发布版本，也不代表已经发布的 DSH 版本。[manifest.json](manifest.json) 记录精确基线、SHA-256、应用后的源码树、能力和验证边界。请将补丁与 manifest 一起维护。

使用精确提交的干净 checkout、Node.js 24.9 或更新版本，以及上游 `pnpm@11.28.5` 工具链。在该 checkout 中，先检查，再应用下面文件的绝对路径：

```sh
git apply --check /absolute/path/to/compat/dsh-web-host-ca33fd68.patch
git apply /absolute/path/to/compat/dsh-web-host-ca33fd68.patch
pnpm install --frozen-lockfile
pnpm run build
```

按照补丁后 checkout 的开发说明运行其 SDK 或构建桌面应用。已安装的桌面端仍会使用自己捆绑的宿主，直到替换为包含这些改动的构建。在另一个 checkout 中应用补丁不会修改该桌面端。不要强行向其他基线应用此补丁；上游变动后，应审查并重新生成补丁。

补丁包含源码、专项测试、中英文 API 参考、生成的目录、依赖引用，以及可选会话事件字段所需的兼容性记录。现有会话日志版本保持不变。旧读取方可以忽略这些可选字段，但不能提供恢复授权和新的宿主接口。

## 公开运行时契约

| 所有者 | 能力标志，版本均为 1 | 公开行为 |
| --- | --- | --- |
| `ctx.agentLoop.hostPolicyCapabilities` | `replayVeto`、`durableResponseAck`、`recoveredResponse` | 强制重试否决、等待持久 assistant 提交、显式接纳已捕获响应 |
| `ctx.compaction.hostPolicyCapabilities` | `summaryRoute`、`pressurePolicy`、`durableSummaryAck`、`recoveredSummary` | 显式摘要目标与经校验的路由预算、独立持久检查点确认、显式接纳摘要 |

`agent/replay-check` 在重试恢复之前和再次分派之前各运行一次。所有匹配监听器都必须结束；`always` 重试设置不能覆盖拒绝。插件必须把否决限制在自己负责的请求。没有监听器时，原有 Provider 重试行为保持不变。

`agent/response-committed` 在模型迭代器关闭、assistant 事件追加、会话 flush 完成之后且工具执行之前运行。`compaction/committed` 在摘要、替换记录和成功结束记录提交并 flush 后运行。外部 Provider 确认交付之前，必须要求其 `durable` 标志为 true。这两个回调都不能等待同一个 Agent 进入空闲状态。

`compaction/summary-route` 接收拟切换的目标与原有默认摘要路由。`compaction/pressure-policy` 通过现有严格预算校验器合并显式路由覆盖。`llm.stream(options, observeResolved?)` 在普通中间件运行之后，将实际绑定的适配器路由和已解析控制参数交给摘要器，保证记录的推理档位和输出上限与真实调用一致。没有处理的路由保留上游默认策略。

`ctx.agentLoop.adoptRecoveredResponse(agent, input)` 和 `ctx.compaction.adoptRecoveredSummary(agent, input, signal)` 分别要求对应恢复策略事件、当前 Agent 维护保留、成功 flush，以及可读取的 `sessionPersistence` 后端。它们验证原始 surface 与请求、完整产物摘要和已有持久提交的身份。主响应接纳在 assistant 持久提交之后才使用普通工具流水线。摘要接纳使用正常的配对范围、缩减和替换事务，不会创建 assistant 消息。已经提交的结果直接返回，不再执行工具或替换历史。报告失败时可能已有部分持久提交，因此必须保留日志进行对账，不能自动重新发送请求。

## 验证与边界

受影响源码项目、专项测试的 TypeScript 检查、修改文件的 lint、导出 API 文档、类型等价参考及生成的 Cordis 目录检查均通过。先前的专项验证覆盖 19 个文件，共 512 个测试通过。最后的摘要身份修正通过全部 18 个摘要策略测试，其中包含 8 个新增拒绝用例；6 个真实跨层场景也重新运行通过。恢复用例使用真实 JSONL 后端和原生写入租约；仅有空的 flush 回调不能满足恢复准入。补丁已在隔离 Git index 中验证，可以干净应用到精确基线。

在本插件的开发 checkout 中，可以针对已打补丁的 DSH checkout 运行跨层验证。可选的第二个 checkout 参数会接入 Flywheel 的真实 Web 策略消费模块：

```sh
node scripts/verify-web-harness.mjs /path/to/patched/deepseek-harness /path/to/flywheel
```

验证脚本使用真实 DSH AgentLoop、BasicCompaction、JSONL 持久化、本插件的传输和日志，以及公开钩子。只有浏览器页面使用脚本化对端。覆盖默认插件组合、持久确认后的工具执行、显式恢复、自动和手动压缩，以及强制重试否决。可选 Flywheel 路径验证其真实准入和终态回执模块。运行前请为当前宿主构建上游原生 system addon。

本运行环境未能完成上游完整构建：`tsx` CLI 的 IPC socket 被拒绝，直接重跑的完整宿主聚合 TypeScript 进程又超过可用内存。通过 `node --import tsx` 直接运行以及受影响源码、测试检查成功。JSONL 测试使用未改动的上游 flock C 源码、稳定 N-API 8 和经过完整性核验的官方 `node-api-headers@1.9.0` 编译，因为运行环境的 Node 安装缺少开发头文件。补丁不包含 addon 二进制，也没有替换锁实现。真实账号、浏览器和 macOS 桌面验收仍需在实际部署环境完成。
