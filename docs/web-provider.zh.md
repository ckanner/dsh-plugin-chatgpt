# GPT-6 Pro Web：设置与恢复

[English](web-provider.md) | 中文

本分支在未修改的 DSH 上实现显式启用的 `chatgpt / gpt-6-pro-web / pro` 路由，包括专用 Chrome 进程、私有本地 daemon、持久化浏览器与请求 journal、精确图片版本，以及现有 ChatGPT provider 卡片中的设置和恢复操作。这是尚未发布的候选实现；registry 中的旧版本不会自动获得这些改动。

仍需用目标账号和操作系统完成真实 ChatGPT 网页验收。真实 Chromium fixture 在本地网站上验证浏览器机制，stock AgentLoop 测试验证宿主工具和 checkpoint；两者都不能证明账号权限、当前登录网页布局或真实 Pro 的端到端结果。网页证据缺失或冲突时，请求会停止。

## 前提与显式宿主策略

使用支持的 Node 22/24、具备图形桌面的本机 Chrome/Chromium，以及 POSIX 宿主。实现包含 macOS 和 Linux 的 Chrome 路径发现。stock 宿主 gate 使用已发布 DSH `0.2.2-rc.5`；更宽的 peer 范围和包导入成功，不代表每个版本都完成了真实验收。尚未实现 Windows profile 持久化。

DSH 继续拥有所有工具、权限、权威历史、重试与压缩。Web provider 无法强制 `maxTokens`、`temperature`、`stop`，因此明确拒绝这些参数。启用模型前，必须在**实际运行的 compaction service**中配置显式的非 Web 摘要路由；只在插件本地声明一个配置不算数。还需设置显式的本地 token 预算，它用于准入和压缩，并不是检测到的 ChatGPT 上下文容量。

对于条目名为 `chatgpt`、`compaction-basic`、`session-title-llm` 的 stock profile，把以下字段合并到对应的现有配置中：

```yaml
- id: chatgpt
  config:
    # 保留该条目现有的 provider、stateDir 等设置。
    modelContextWindowLimits:
      gpt-6-pro-web: 32768
    webMaxInputBytes: 262144
    # Chrome 不在标准位置时可显式设置：
    # webChromeExecutable: /absolute/path/to/chrome

- id: compaction-basic
  config:
    auto: true
    modelPolicies:
      - provider: chatgpt
        model: gpt-6-pro-web
        headroomTokens: 4096
        retainTokens: 4096
        summarizationProvider: chatgpt
        summarizationModel: gpt-6.2-sol
        maxTokens: 4096

- id: session-title-llm
  config:
    # 保留标题插件现有的目标长度与超时字段。
    provider: chatgpt
    model: gpt-6.2-sol
```

摘要和标题模型必须在你配置的 provider 中可用；`gpt-6.2-sol` 只是示例，不是账号权限证明。插件通过 `ctx.llm.resolveModelInfo` 解析该路由。精确模型策略覆盖压缩默认值；空摘要配置、回落到 Web、关闭自动压缩、重复目标策略以及不可用的 headroom/retention 都会被拒绝。已启用的 stock 模型标题插件也必须有显式非 Web 路由；也可以关闭该可选插件，保留宿主的确定性标题服务。插件只读取这些设置，不会静默重写，也不会擅自选择会计费的备用模型。

## 启用模型

1. 把构建后的候选包安装到目标 DSH profile，并重启该宿主。
2. 打开 **设置 → 模型 → ChatGPT → GPT-6 Pro Web**，点击 **Open dedicated Chrome**。它在 `<stateDir>/web/profile` 下创建私有 profile，不连接日常浏览器。
3. 在专用窗口中手动登录，只保留一个 ChatGPT 页面。选择可见的 **GPT-6** 模型和 **Pro** effort。登录、验证挑战和账号提示由你自己完成。
4. 点击 **Verify account and Pro**。宿主从可见账号和模型控件读取证据，把 profile 绑定到该账号；不会读取 cookie/token 存储，也不会修改账号的记忆或隐私设置。
5. 解决列出的宿主策略问题，再点击 **Enable Web model**。普通模型选择器会增加 **GPT-6 Pro Web**，唯一 effort 为 `pro`。

Web 账号与 SIWC 授权相互独立。如果显式摘要或标题路由使用 SIWC，该授权也必须可用。GPT-6.2 与 UltraFast 继续走原 SIWC 路由。禁用 Web 会阻止新 Web 请求；释放一个插件客户端不会终止 daemon 或其他客户端的工作。

Chrome 路径、提示字节上限与空闲超时由显式 setup 保存。后续 setup 在没有活动 Chrome/engine 时，可以更新明确传入的值；省略的字段保留旧值。活动 runtime 使用不同配置时，需释放其客户端、等待空闲关闭，再重试 setup。状态查询、核验和连接不会静默改写这些设置。

每个新代次都会在持久化 intent 后创建空的、私有的 **project-only Project** 和独立 chat。只有 DSH prefix、receipt 链、账号、Project、conversation 和可见网页历史都一致时，才接纳继续追加。压缩、fork、指令或工具历史变化会基于当前宿主输入创建新代次。bridge 不维护第二套摘要，也不截断历史来适应网页。发送前再次核验 project-only、私有性、空 sources 和精确模型控件；未知布局会明确失败。

DSH 的角色、指令、历史和工具定义会投影为网页提示；这不会替换网站本身的系统指令，也不证明所有账号个性化设置均不存在。adapter 不创建分享链接，也不会检查每个已存在的会话分享链接；单独的私有 Project 检查不代表任何人都不可能分享过 chat。账号隐私和记忆设置仍由账号所有者控制。

## 图片与完整响应

用户图片和工具结果图片通过公开 DSH attachment service，从已脱离调用方可变数据的请求快照解析。宿主已 offload 的图片保持 offload。PNG、JPEG、WebP、GIF 字节会核对声明的 MIME、长度和 SHA-256。传输限制为每张 20 MiB、最多 20 个不同版本，以及包含 base64 开销在内的完整本地请求体 32 MiB。这些是本地边界，不承诺网页能接纳同样大小。

私有 blob store 对每个精确图片版本只保存一次。journal 请求保存摘要引用，重新打开时逐一验证，并在使用前恢复同一版本字节。网页上传使用按内容命名的文件名；bridge 同时检查 composer 和已接纳提示中的完整图片集合。缺少或损坏字节会停止该 profile，而不是静默丢图。不接受任意路径、远端 URL 或文件附件。

完整网页提示 envelope 默认最多 256 KiB。响应、receipt framing 和 inspection 保持在 1 MiB 边界内。网页必须返回对应精确请求的完整 JSON envelope；engine 在持久化前验证每个 block 和工具 schema，客户端在暴露任何 DSH chunk 前验证 response、finish 和 EOF。不伪造思考文本或 usage。工具只在有限模型响应结束后，由原版 DSH AgentLoop 执行。

## 检查、恢复与放弃

provider 卡片提供 **Load turns**、**Inspect**、**Recover from page evidence** 及显式放弃操作。列表显示最新 100 轮的摘要；更早的请求仍可通过 CLI 按精确 ID 检查。检查展示已记录状态和完整响应，不会执行其中的工具 block。恢复只观察网页、更新本地证据，绝不点击 Send 或运行工具。profile 阻断错误会指向真正未解决的那一轮，即使触发该错误的是另一个新请求。

| 状态或错误 | 含义与下一步 |
| --- | --- |
| `WEB_UNCERTAIN` | 已派发请求没有完整验证的交付结果。用 `requestId`/turn ID 检查并恢复，然后才能继续新请求。 |
| `WEB_DELIVERY_CLAIMED` | 工具响应已提交唯一交付所有者。重新连接不能重放，需核对 DSH session 和工具历史。 |
| `failed` 且保留 Send 前浏览器证据 | 恢复可以证明从未出现 Send intent。原请求保持终态；显式放弃该浏览器证据后才能继续，并检查残留草稿或上传。 |
| `discarded` 且 `uncertain` | 结果已放弃，远端操作仍不确定。继续只读恢复；放弃操作不会解除该阻断。 |
| 绑定、journal、图片或所有权错误 | 检查已保存状态。重新运行 setup 不会替换现有账号绑定或抹掉证据。 |

相同精确请求的完整文本响应可以重放。带工具的响应只有一次持久化交付声明，即使相同所有者也不能再次获取可执行重放。这不是宿主持久化 ACK，也不是工具已执行的证明。新的语义请求、新的 DSH session 和新的 Flywheel 任务都是不同身份，因此 Flywheel 仍需消费端的不确定结果阻断。

CLI 使用相同管理接口：

```sh
dsh-chatgpt-web setup --state-directory /absolute/stateDir/web --provider chatgpt
dsh-chatgpt-web status --state-directory /absolute/stateDir/web
dsh-chatgpt-web verify --state-directory /absolute/stateDir/web
dsh-chatgpt-web enable --state-directory /absolute/stateDir/web
dsh-chatgpt-web turns --state-directory /absolute/stateDir/web
dsh-chatgpt-web inspect --state-directory /absolute/stateDir/web 'turn-<sha256>'
dsh-chatgpt-web recover --state-directory /absolute/stateDir/web 'turn-<sha256>'
dsh-chatgpt-web discard --state-directory /absolute/stateDir/web 'turn-<sha256>'
```

CLI 的 `enable` 控制 daemon 可用性；已安装 provider 仍会在模型解析和派发前独立核验实际宿主辅助路由与预算。token 保存在仅属主可读文件中，不会由 setup/status 打印或发送到 provider 卡片。管理和模型 HTTP listener 都绑定字面值 loopback，并拒绝浏览器 Origin。握手同时验证私有凭据、协议和包版本、instance nonce、物理 profile、安装和账号绑定。

daemon 在启动 Chrome 前取得物理 profile 所有权，并验证浏览器实际命令行。插件客户端只释放自己的 lease。空闲关闭会等待所有客户端、活动操作和不确定结果；Chrome 清理只针对已证明属于自己的进程。不能仅凭 PID 回收缺失或改变的锁。崩溃后，必须先确认没有所属浏览器或 bridge 操作仍在运行，并检查 journal，再离线修复锁。没有自动抢锁或删除证据的命令。快照 journal 上限为 64 MiB，达到上限后停止新请求，不删除历史。

## 验证与发布边界

```sh
npm ci --ignore-scripts
npm test
npm run build
npm run typecheck
npm run verify:client
npm run verify:install
npm run verify:web-agent-loop -- /path/to/stock-dsh --deps /path/to/host-dependencies
npx playwright-core install --with-deps chromium
DSH_TEST_CHROMIUM=/absolute/path/to/chromium npm run test:web-browser
```

独立 Chrome CI job 会显式启用真实浏览器测试；Chromium 不存在或无法启动就失败，不用 mocked page 方法冒充浏览器运行。普通离线测试覆盖精确图片重放、schema、fsync 故障、lease、请求身份、dispose、独立 daemon 客户端，以及 stock 宿主工具和 checkpoint。

宣称真实验收通过前，应使用目标登录账号验证：文本、一个本地工具及其后续请求、用户与工具结果图片、压缩后新 Project、provider 切换、取消、交付中断、DSH/daemon 重启，以及两个独立释放的客户端。记录浏览器、OS、DSH 版本和 journal/session 证据。任何 fixture 结果都不能替代这项账号绑定的验收。
