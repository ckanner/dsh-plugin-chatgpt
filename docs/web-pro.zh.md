# ChatGPT Web Pro

[English](web-pro.md) | 中文

这个候选版本在 DSH 原生模型选择器的现有 `chatgpt` Provider 下增加 **GPT-6 Pro · Web**。它使用单独登录的专用 ChatGPT 浏览器连接。DSH 继续负责会话、本地工具、权限和压缩，浏览器提供模型回答。

**发布状态：** `0.2.0-alpha.1` 是开发候选版本，尚未发布到 npm。Web 调用需要下文所述的维护版 DSH 兼容补丁。真实 macOS、已登录的 ChatGPT 账号以及当前网页布局尚未完成验收。离线 fixture 能验证实现行为，不能证明真实账号的能力可用。

## 1. 选择准确的模型

| 配置 | 值 |
|---|---|
| Provider | `chatgpt`；本安装显式重命名路由时使用实际名称 |
| 模型 ID | `gpt-6-pro-web` |
| 模型显示名称 | `GPT-6 Pro · Web` |
| 思考档位 | `pro`；显示为 **Pro** |
| Transport | `chatgpt-web` |
| 默认网页上下文策略 | `project-only` |

`gpt-6-pro-web` 是本插件定义的模型标识，不是 OpenAI API 模型名称。浏览器适配器会在本次拥有的会话中核验网页的 **GPT-6** 与 **Pro** 控件；控件不可用或无法识别时拒绝准入，不会将 `pro` 改成其他模型或档位。

兼容的 DSH 调用方只要支持 provider/model/effort 绑定，就可以在普通对话、规划、review 或带本地工具的执行循环中选择它。调用方仍决定该角色可以使用哪些工具和权限；选择能力更强的模型不会额外授予权限。

## 2. 一个 Provider 行，两条独立连接

| 项目 | 现有订阅模型 | GPT-6 Pro · Web |
|---|---|---|
| 连接 | Sign in with ChatGPT，简称 SIWC | 使用专用 Chrome profile，手动登录网页 |
| 模型发现 | 账号目录及现有 SIWC 元数据策略 | 在 Provider 卡片中显式启用的 Web 模型 |
| 凭据 | 插件管理的 SIWC 授权 | 浏览器管理的网页登录，以及独立观察到的账号指纹 |
| 上下文预算 | SIWC 模型元数据及其配置覆盖 | 本地 Web 字节策略与宿主压缩策略 |
| 图片 | 现有 SIWC 附件和视觉契约 | 从持久 user/tool 图片引用有界上传 PNG/JPEG/WebP/GIF；普通文件明确拒绝 |
| 用量 | SIWC 通道上报的计数 | 网页没有权威计数时保持 unknown |

SIWC 登录或登出不会替专用浏览器登录或登出。SIWC 的 `contextWindowLimit`、`modelContextWindowLimits` 和服务端 `proxyUrl` 不配置 Web 上下文或 Chrome 网络。Web 模型启用后可以先出现在选择器中，再连接浏览器账号；模型发现不代表实时就绪。

本实现拥有自己的浏览器传输与恢复协议，不在运行时调用 Oracle，不借用无关的个人浏览器标签页，也不把网页包装成官方 OpenAI machine API。

## 3. 安装兼容宿主与候选插件

先按[兼容环境安装说明](../compat/README.zh.md)操作。维护的补丁文件为 [dsh-web-host-9c2670d3.patch](../compat/dsh-web-host-9c2670d3.patch)，准确基线和验证元数据记录在 [manifest.json](../compat/manifest.json)。

DSH 的精确基线为：

```text
9c2670d3bce5275e0d1610272958121af87787bb
0.2.2-rc.5
```

在该 commit 的独立 checkout 上应用补丁，然后按兼容说明构建并运行生成的宿主。版本字符串本身不能证明兼容。只把插件安装进原版 SDK 或 Desktop，不会补出缺失的宿主接缝。

Web 准入要求 **`summaryRoute` 为版本 2**，`replayVeto`、`durableResponseAck`、`durableSummaryAck` 和 `pressurePolicy` 为版本 1。摘要路由 v2 明确区分用户配置的摘要目标与历史继承的会话路由；旧兼容宿主仅有 v1 时会在派发前拒绝，须使用本候选配套补丁更新宿主。设置卡与运行时共享同一份能力要求。显式恢复采纳还需要对应的 `recoveredResponse` 或 `recoveredSummary` 能力；普通 SIWC 路径保留原有宿主要求。

在本插件 checkout 中构建本地候选包：

```sh
npm ci
npm run build
npm pack
```

将生成的本地压缩包安装到补丁宿主实际使用的 profile：

```text
dsh plugin --profile <name> add /absolute/path/dsh-plugin-chatgpt-0.2.0-alpha.1.tgz
dsh --profile <name> --dump-config
```

使用补丁宿主提供的 CLI 执行这些命令，修改 profile 后重启该宿主。检查组合结果中确实有此插件和唯一一个启用的 DSH 压缩引擎。主 README 的 registry 安装命令描述已发布的 SIWC 包，不能据此认定 Web 候选包或兼容宿主已经发布。

## 4. 连接专用浏览器

1. 打开 **设置 → 模型 → ChatGPT**，找到 **ChatGPT Web · GPT-6 / Pro**。
2. 为 **Chrome executable** 设置绝对路径，为 **browser profile** 设置专用目录，并另外设置私有 **recovery directory**。先保存再连接，不要使用个人 Chrome profile、用户主目录或共享目录。
3. **Conversation context** 保持 **Private project-only workspace**。启用 Web 模型并保存。
4. 点击 **Connect / verify login**。插件打开专用 Chrome 的登录界面，不发送 prompt，也不创建项目。请在该窗口手动完成网页正常登录。
5. 登录后再次点击 **Connect / verify login**，让插件观察并绑定专用账号。此后账号不匹配会报错，不会静默换绑。
6. 在 DSH 普通模型选择器中选择 **GPT-6 Pro · Web** 和 **Pro**。先在预期的工作目录与权限模式下运行一个小型、低影响任务。

macOS 默认可执行文件为 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`，Linux 为 `/usr/bin/google-chrome`。安装位置不同就填写实际绝对路径。默认目录为 `<plugin stateDir>/web-browser` 和 `<plugin stateDir>/web-runtime`；字面量 `~` 不算绝对路径。

通常由卡片保存的设置放在私有目录中。如果 DSH profile 显式配置了 `web` 对象，则以该对象为准，配置变更需要编辑该 profile。账号指纹必须来自实际观察到的专用账号；不要把 SIWC 凭据复制到 Web 字段，也不要编造指纹绕过连接核验。

对于 profile 管理的连接，**Save Web settings** 按钮被禁用。Connect 可以核验已经绑定的账号，不会改写 profile。若指纹为空，Connect 显示实际观察到的 hash：将其写入所属 profile 的 `web.connections[web.activeConnection].accountFingerprint`，重载配置后再次 Connect。卡片不会覆盖 profile 管理的设置。已完成调用会列在 **Recent Web conversations** 中，并提供所属网页聊天的链接。

**Account: Bound** 表示已保存账号身份，**Required extensions present** 表示宿主契约满足要求；两者都不能证明当前网页模型可用或布局已验证。实际调用仍会再次核验账号、模型、档位和网页上下文。

## 5. 网页上下文与本地执行

默认受管模式为每个逻辑会话的每一代创建一个新的、私有的 project-only ChatGPT 项目。主调用、子代理和辅助调用分别拥有自己的会话；摘要或标题辅助请求不会追加到主聊天。准入检查包含账号、project-only 设置、项目指令与来源、共享状态、模型、档位以及聊天所属项目。

无法核实上述条件就停止调用。受管模式不会降级到个性化首页聊天，也不会修改用户全局账号偏好。**Personalized chat** 是普通交互可显式选择的设置，可能包含 DSH 之外的上下文，不适合要求独立性的 review；Flywheel 受管 Web 绑定要求 `project-only`。

上传图片或输入文本前，适配器再次核验绑定账号、GPT-6/Pro 选择、准备好的聊天及项目，并检查没有活动生成或已启用的受支持 hosted-app/agent-mode 控件。URL 没变不代表这些事实没变；图片上传后还会复核一次。不匹配时停止提交，不静默切回模型或重发请求。

模型返回本插件定义的 JSON envelope，内容为最终文本或一批本地工具请求。暴露任何工具请求前，插件先验证整份响应、请求与代次身份、重复 key、嵌套深度、调用 ID、工具名称，并按准入的 JSON Schema 校验每个参数。批次非法时不会先执行其中一部分。

DSH 通过正常的工具运行时、工作目录、sandbox 和权限执行已接受的工具，网页不会直接执行这些本地工具。网页 hosted apps 属于另一类能力，也必须满足受管上下文检查；本地 sandbox 设置不能证明远端 app 的行为。完整回答及本地清理均确认后，纯语法错误可触发次数有界的格式修正；被拒绝响应中的工具不会提前暴露。

每个受管本地工具（包括非 Web 子调用）都绑定所属 DSH session 与原始持久 `tool/call` 事件。结果必须通过 `sourceEventSeqs` 引用该事件，并匹配其 turn 和 step，才能结算对应的工具树。后续步骤或兄弟 session 复用短调用 ID 时仍属于不同次执行。历史结果和旧版仅记录 ID 的回执不能证明本次完成；某次嵌套工具结果未知时，后续同 ID 调用成功也不能解除该阻断。

工作区归属优先读取当前 Agent 的公开 `workingDirectory.get(session)`。只有宿主没有该服务时才使用不可变的 session header；当前目录读取失败不能悄悄退回旧目录。根 Agent 或子 Agent 切换 worktree 后保留原执行域，并在受管操作前登记新的物理目录。已有目录关联继续保留，因此未决操作在重启后仍会阻断任一受影响目录中的 fresh 或非 Web Agent。

可读项目与聊天名称在本地根据任务和代次生成，设置名称不额外调用一次 Pro。能够识别用户改名时保留该名称。若 DSH profile 启用了模型生成 Session 标题的服务，那仍属于独立的辅助模型调用。

### 格式修正与被拒绝的响应

`maxFormatRepairs` 默认 **1**，可在 Web 卡片或 profile 的 budget 中设置为 **0–2**。修正是原 owned 聊天中的一次独立模型回合，只携带已捕获回答及其 digest，不重放原任务、历史或图片。全部尝试共享原绝对 deadline、输入限制、输出预留与累计字节预算，用量保持 unknown。

修正须通过机械等价校验：只有单层 JSON Markdown fence 可以被去掉，且内部完整 envelope 必须通过原校验，所有字段、工具 ID、名称与参数完全不变；非结构化文本只能逐字包装为最终文本。身份错误、重复字段、非法工具 schema、未知工具或参数变化仍会被拒绝，不自动猜测有歧义的工具请求。原始 artifact 与父子调用身份持久保存；语法修正不构成宿主 ACK，只有最终验证通过的尝试接收正常 durable host ACK。下一模型调用从 DSH 权威历史建立新 generation。

修正失败或中断后，只读恢复不会自动重发；未知派发继续阻断。对完整但被拒绝的回答，点击 **Inspect captured result** 可查看拒绝原因与 digest，再点击 **Discard rejected response** 明确丢弃。丢弃绑定已查看的 digest，保留证据，以失败结束该请求，仅释放已证明终态的容量；不伪造成功、不执行工具，也不解除其他未知调用或工具结果。已经交付的有效回答必须走正常 adoption，不能丢弃。新任务或代次仍由后续明确动作触发。

## 6. 长会话与压缩

DSH 的持久事件历史是真实依据。在兼容的一代中，插件发送新的权威历史后缀，而不是每轮工具调用都重发完整会话。前缀、system、工具注册表、连接、策略与代次检查防止把不相关历史追加到已有浏览器会话中。

本地历史或轮数压力、权威前缀变化可以触发新的浏览器代次。新一代从 DSH 当前历史接收有界 bootstrap。迁移不能抹掉未决远端派发、尚未提交的响应或结果不确定的工具。

系统只有**一个 DSH 压缩引擎**。插件提供 Web 摘要路由和 `compaction/pressure-policy`，不再隐藏运行第二个摘要器。自动和手动压缩共用宿主公共事务与持久摘要确认。显式配置的 `BasicCompactionConfig.summarizationProvider` / `summarizationModel` 优先于主会话模型：配置其他摘要模型时保留其实际路由与记账；显式配置 Web 摘要时，即使主模型不是 Web，也会在独立辅助会话中使用 **Pro**。未显式配置摘要目标时，当前准备使用的 Web 模型优先于历史继承的旧会话路由。摘要选择不会改变主模型。

手动压缩在整个 maintenance 保留期间都以实际 Agent 为发起者，保留其工作区、原始压缩事务和选中的历史范围。摘要已捕获但回传中断时，未决状态会阻断该工作区；用户可通过原摘要事务显式采纳，无须再次调用模型，也不会追加成 assistant 消息。

包括协议、工具 schema 开销在内的完整序列化 prompt，必须在浏览器派发前满足 Web 字节策略。单个输入无法安全压缩或拆分时拒绝调用。压缩有损；切换浏览器会话不会重置账号额度，也不能提供无限上下文。

### 默认本地策略

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxInputBytes` | 96 KiB | 包含输出预留额度的输入 envelope 预算 |
| `outputReserveBytes` | 32 KiB | 默认给完整序列化 prompt 留下至多 64 KiB |
| `maxResponseBytes` | 1 MiB | 捕获的完整响应 artifact 上限 |
| `maxHistoryBytes` | 256 KiB | 用于代次迁移的本地累计字节预算 |
| `maxTurns` | 24 | 每个浏览器代次的模型调用轮数 |
| `maxGenerations` | 16 | 持续主会话的代次上限 |
| `maxToolCalls` | 16 | 单次响应中最多允许的已校验工具调用数 |
| `maxJsonDepth` | 48 | 响应 JSON 最大嵌套深度 |
| `maxFormatRepairs` | 1 | 额外语法修正回合，可配置为 0–2 |
| `wallTimeoutMs` | 60 分钟 | 本地 invocation 总时限，外层可以设置更短时限 |

这些都是本地策略，不是官方 GPT-6 或 ChatGPT token 窗口声明。token-meter 提示从字节预算推导，最终序列化字节检查仍然有效。完整响应上限与较小的输出预留是分开的限制；提高本地上限不能证明网页会接受更大的请求。

### 图片输入与上传回执

Web 模型声明支持用户附件和工具返回的图片，包括 LCU 截图。DSH 必须提供真实的持久 `image` 内容块；工具打印的截图 handle 或文件名不算图片。附件服务读取已保存的标准化图片并验证引用，插件再核对返回的格式、尺寸、编码字节数和文件签名，生成私有且带 hash 的上传 artifact。宿主原始历史继续保留持久引用。普通 `file` 块、不可读取的附件、不支持的角色或格式会在浏览器派发前报错；宿主已 offload 的图片保留明确的缺失说明，不重新读取其字节。

在 Provider 卡片的 **Image upload limits / 图片上传限制** 中配置以下限制；使用 profile 时对应 `web.imagePolicy`。限制针对本轮实际上传批次：兼容会话只上传权威历史中的新消息，切换代次则上传当前有界 bootstrap。已接受的前缀图片不重复计数，重启续接也不重新下载或上传。新代次的 bootstrap 必须独立满足限额，超出时通过宿主压缩或 offload 处理。这些是本地准入限制，不代表网页账号额度。

| `web.imagePolicy` 字段 | 默认值 | 绝对上限 |
|---|---|---|
| `maxImages` | 每批 10 张 | 20 张 |
| `maxImageBytes` | 单图 20 MiB | 20 MiB |
| `maxTotalBytes` | 每批 32 MiB | 64 MiB |

每张图使用与原消息位置、角色以及工具结果 `toolCallId` 绑定的确定性上传名称。prompt 保留此关联及图片元数据，不把图片字节混入文本。新聊天和续聊都会固定准备完成时的 composer URL，在上传图片或输入 prompt 前重新检查；标签页若已跳到其他聊天，会在发送前拒绝。随后浏览器设置真实的 composer 文件输入框，核验准确的附件名称和明确上传完成事实，再检查账号、模型及会话归属后发送。只有本地预览、预分配 file ID、spinner 消失或 Send 按钮可用，均不足以证明上传完成。无法提供明确完成证据的网页布局会被拒绝。

发送后，完全相同的图片名称还必须出现在原来接受 prompt 的那条用户消息中。持久回执用 `modelConsumption: 'unverified'` 表示已核验 UI 接受，不能据此证明模型理解了像素。捕获与恢复保留原私有 artifact 和消息关联，不重新上传结果未知的回合。未决回合恢复前应保留连接的恢复目录；原始字节缺失或被修改时不能采纳。真实登录账号的上传兼容性和视觉任务质量仍需单独验收。

## 7. 活动、并发与取消

活动通知只携带有界身份、序列号以及实际观察到的 prompt 接受、内容、阶段和完成变化，不包含回答正文，也不生成虚假的心跳。网页回合在两次观察之间可能是不可见阶段，调用方不能把没有输出直接当作进程挂死的证据。

连接并发默认为**一个远端模型回合**。进入本地工具或子代理等待前释放容量，避免父代理占着浏览器槽位等待需要同一槽位的子代理。排队和重连保留剩余 wall 预算，取消必须阻止迟到发送。未决远端回合仍保留其容量责任，不能通过杀掉本地 worker 把它当成空闲容量。

本地清理与远端生成是独立事实。关闭 CDP 客户端或观察到本地进程退出，不能证明网页已停止生成。取消会尝试停止准确归属的请求并排空拥有的本地工作；缺少远端确认时仍保持 unknown。

## 8. 恢复被中断的操作

Provider 卡片在 **Recovery needed** 中列出未决操作。保留原 profile、插件 state、恢复目录和 DSH 会话历史，它们共同标识原调用及其持久回执。

1. 点击 **Inspect captured result** 核对原操作。它读取现有 artifact 或观察原来拥有的浏览器会话，可以更新本地恢复证据，但不发送新 prompt、不重新生成回答，也不执行本地工具。
2. 检查恢复的响应、原会话及请求的工具效果。已知完整响应仍需要对应的宿主提交。
3. 仅在确实希望提交该已捕获响应时点击 **Adopt response and its tools**。在兼容的存活宿主中，采纳会核验原请求、surface 和私有 artifact，然后走正常宿主事务。主响应可能按原权限执行其中已验证的本地工具；摘要走自己的摘要事务。
4. 采纳**不会自动继续下一次模型请求**。检查更新后的会话，再明确选择后续操作。

采纳不能顺便结算无关的未知工具、其他未决响应、已改变的会话 surface 或缺失的原始归属。检查不通过时保持阻断。重启进程、新建 Session、切换 Provider 或新建浏览器会话，都不能授权重放同一工作区的未决执行域。

恢复采用与正常调用相同的完成检查。网页出现生成错误时，残留文本或 Copy 按钮不能构成可采纳的完整回答，原调用继续保持未决；之后再次检查，可以观察到真正完成的原回答，无须重发 prompt。

| 事实 | 回答的问题 |
|---|---|
| Dispatch | 原请求是否已发送：已确认、确认未发送，还是未知？ |
| Outcome / 宿主提交 | 是否捕获到合法回答，并由所属宿主持久接受？ |
| 远端生成 | 原远端回合仍在运行、已经终止，还是未知？ |
| 本地清理 | 拥有的本地资源是否已释放？ |
| 用量 | 是否有权威计数？ |

业务结果未知、本地清理已确认，是有效组合。未知用量不等于零用量。恢复只保存能够确认的事实，不编造其余部分。

## 9. Flywheel 与其他 SDK 调用方

Flywheel 消费的是同一个 DSH 模型。在支持的角色或 Loop 中配置准确的绑定：

```yaml
harness: dsh
provider: chatgpt
model: gpt-6-pro-web
thinking: pro
```

这只是绑定片段，不是完整 Flywheel 任务配置。Flywheel 使用的 SDK profile 必须实际加载本候选插件、兼容宿主扩展和唯一压缩引擎。只在另一份 Desktop profile 中安装插件，不会使另一个 SDK 进程自动获得它。原版 SDK 必须拒绝准入，不能假装已经支持 Web。

公共 `chatgptWebHost` 服务协商准确绑定与 invocation 身份。其版本 1 回执包含 transport、连接、账号、上下文策略、观测能力和 unknown 用量。`dsh-plugin-chatgpt/web-host` 导出声明 `webHostCapabilities` 与 `web-runtime/1`；导入它只检查静态契约，不会启动 Chrome 或核验账号。

SDK 调用方可在提交 prompt 前取得 `chatgptWebHost.recoveryCheckpoint(identity)`。原 SDK owner 退出后，`dsh-plugin-chatgpt/web-recovery` 导出的 `readWebInvocationRecovery(checkpoint)` 只读取原私有宿主、浏览器、artifact、图片与提交证据。这个独立入口不启动 SDK 或浏览器、不写 journal、不采纳响应，也不发送 prompt；记录中的身份、设置、执行域版本、artifact 改变，或工具/远端结果不完整时均拒绝。profile 托管的 checkpoint 冻结原设置；下一次实际 SDK 准入仍须核验当前 profile。

已提交模型回答本身不能证明原 SDK 任务已完成。Flywheel 还要求原 worker checkpoint、prompt/wait/terminal 与清理证据，以及未变更的 candidate/role 守卫。它可对账确认未发送的调用、SDK 已完整结束但结果回传丢失的调用，以及 SDK 已确认退出后显式丢弃的无效结果。仅采纳 final、工具响应或摘要，而缺少原 SDK 完整业务证据时，任务继续阻断。恢复保留 unknown 用量，不自动重放原任务。

Flywheel 保留既有预算和权限规则。当实际用量未知时，hard token budget 可能阻止后续调用。选择此模型不会静默放宽规则，插件也不会把估算的 token 数当成权威用量或费用上报。

## 10. 当前验收边界

| 项目 | 当前边界 |
|---|---|
| 真实账号与 UI | 真实 macOS、已登录 ChatGPT 账号和当前网页布局尚未完成端到端验收。运行时仍要求账号具有能力且可见控件匹配。 |
| 浏览器环境 | CI 在 Linux 与 macOS 上运行精确补丁宿主及隔离的真实 Chrome DOM fixture。本地 sandbox 的 socket 初始化返回 `EPERM`，无法启动 Chrome。CI fixture 不包含已登录账号，也不验证当前 ChatGPT 网站。 |
| 媒体 | 已实现持久 PNG/JPEG/WebP/GIF user/tool 图片、按上传批次限额、私有 artifact 完整性、CDP 选文件以及准确消息接受核验，并以聚焦 fixture 覆盖。真实网页上传控件和模型视觉消费仍未验收；普通文件块明确拒绝。 |
| 网页上下文已满 | 已实现本地字节压力与代次迁移。网页拒绝尚不能提供可靠的无副作用证明；派发有歧义时保持阻断，不自动换聊天重发。 |
| 非法响应格式 | 有界语法修正保持已捕获内容及工具动作完全不变；不可修正的终态结果支持绑定 digest 的显式丢弃。派发、远端状态、本地清理或工具结果未知时仍阻断。 |
| 项目创建中断 | 创建是否成功不确定时，可能需要人工定位原项目；不能自动对账该歧义，连续创建新项目会被阻止。 |
| 浏览器历史与名称 | 保留 owned 项目/聊天并实现命名逻辑。真实账号的历史可见性、回访和当前 UI 命名控件仍属于线上验收。 |
| 用量与吞吐 | 网页 token/费用计数保持 unknown。离线成功不能测出 Pro 的延迟、容量、额度消耗或模型质量。 |

## 11. 验证与实现参考

对候选包和准确的补丁宿主运行适用检查：

```sh
npm run typecheck
npm test
npm run build
npm run check:i18n
npm run verify:package
node scripts/verify-web-harness.mjs /absolute/path/to/patched/deepseek-harness
```

Web harness 验证使用真实 DSH AgentLoop、压缩、工具执行、宿主确认和本地持久化，仅将浏览器页面替换为离线 fixture。协议、传输、会话、恢复与 DOM fixture 测试分别覆盖更窄的边界，均不能替代前述真实环境验收。最终运行结果放在候选版本的验证记录中；本说明不为尚未运行的命令填写通过数量。

- [模型与本地策略](../src/web/policy.ts)、[设置](../src/web/config.ts)和[原生模型注册](../src/index.ts)。
- [公共宿主接入](../src/web/integration.ts)与[执行域归属](../src/web/host.ts)。
- [只读 invocation 恢复](../src/web/recovery.ts)；调用方仍须单独核验原 SDK 任务是否完整结束。
- [增量历史和持久交付](../src/web/session-coordinator.ts)、[工具协议](../src/web/protocol.ts)及[浏览器传输](../src/web/transport.ts)。
- [持久图片准备](../src/web/media.ts)、[图片限额](../src/web/image-policy.ts)及[浏览器上传证据](../src/web/browser/media-dom.ts)。媒体测试覆盖来源关联、artifact 篡改、明确上传完成、增量重启及恢复不重传；Chromium fixture 单独验证真实文件选择，不等同于真实账号验收。
- [DSH 兼容补丁与构建说明](../compat/README.zh.md)。
