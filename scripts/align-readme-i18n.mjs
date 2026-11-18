/**
 * Regenerate `docs/README.zh.md` from `README.md`, keeping the two pages line-for-line
 * equal.
 *
 * The bilingual convention here is not "translate the prose". The English and
 * Chinese pages must match frontmatter key order, headings, blank lines,
 * paragraphs, list items, tables, code fences, and total physical line count one
 * to one. A translation pass cannot guarantee that by itself: a paragraph is one
 * physical line whatever its language, so a hand-wrapped translation silently
 * changes the count.
 *
 * The mapping is therefore **one English line to one Chinese line**, held in a
 * flat table below. A line with no entry must be structural — a fence, a
 * heading, a table rule, an anchor, or blank. Anything else is reported as a gap
 * rather than passed through, because English leaking into the Chinese page is
 * the one failure nothing else would catch.
 *
 *   node scripts/align-readme-i18n.mjs           # rewrite docs/README.zh.md
 *   node scripts/align-readme-i18n.mjs --check   # fail if the pair drifted
 *
 * @module dsh-plugin-chatgpt/scripts/align-readme-i18n
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const englishPath = join(here, '..', 'README.md')
const chinesePath = join(here, '..', 'docs', 'README.zh.md')

/** Chinese text for each English line that carries prose, keyed exactly. */
const LINE_TRANSLATIONS = {
  "English | [中文](docs/README.zh.md)":
    "[English](../README.md) | 中文",
  "![Connect DeepSeek Harness to ChatGPT](assets/screenshot-1-connect.png)":
    "![把 DeepSeek Harness 接入 ChatGPT](../assets/screenshot-1-connect.png)",
  "- [Use this package](#use-this-package)":
    "- [使用本包](#use-this-package)",
  "- [What you get](#what-you-get)":
    "- [你会得到什么](#what-you-get)",
  "- [Understand the implementation](#understand-the-implementation)":
    "- [实现说明](#understand-the-implementation)",
  "- [Further Exploration](#further-exploration)":
    "- [延伸阅读](#further-exploration)",
  "- [Model Experience](#model-experience)":
    "- [模型体验](#model-experience)",
  "- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)":
    "- [已知限制与待办](#known-limitations-and-deferred-work)",
  "- [Dev Note](#dev-note)":
    "- [开发者说明](#dev-note)",
  "## Use this package":
    "## 使用本包",
  "### Install into a profile":
    "### 安装到 profile",
  "The whole install is one line:":
    "安装就是一行：",
  "Restart the harness afterwards: a profile is composed at startup. Removing it:":
    "装完重启 harness：profile 在启动时组合。卸载：",
  "The package is on npm, so the registry is the whole install and no build step is involved:":
    "该包已在 npm 上，因此从 registry 安装就是全部步骤，不涉及任何构建：",
  "Installing from a repository URL instead builds from source, and pnpm refuses a git dependency's build scripts until they are allowlisted: `add https://github.com/ckanner/dsh-plugin-chatgpt` fails with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` until `dsh-plugin-chatgpt` is approved under `onlyBuiltDependencies` in the profile's `pnpm-workspace.yaml`.":
    "改从仓库地址安装则会从源码构建，而 pnpm 在构建脚本被允许之前会拒绝 git 依赖：`add https://github.com/ckanner/dsh-plugin-chatgpt` 会以 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 失败，直到在 profile 的 `pnpm-workspace.yaml` 里把 `dsh-plugin-chatgpt` 加进 `onlyBuiltDependencies`。",
  "The package declares `dsh.bundle`, so adding it appends the bundle to the profile's `dsh.profile.bundles` and inserts its row into the composition. Verify the layer without booting:":
    "本包声明了 `dsh.bundle`，因此添加它会把该 bundle 追加到 profile 的 `dsh.profile.bundles`，并把它的行插入到组合中。可以不启动就检查这一层：",
  "To proxy this plugin's server-side requests, set `DSH_CHATGPT_PROXY_URL=http://127.0.0.1:7897` in the DSH process environment, or set `proxyUrl` in this plugin's profile configuration, then restart DSH. The URL must name an HTTP or HTTPS proxy. This covers the OAuth token exchange, refresh, discovery/revocation, model listing, and inference. It does not change DSH's global network settings or the browser's connection to the authorization page. The proxy must be reachable from the machine running DSH; `127.0.0.1` refers to that machine. Leave the setting empty for direct requests. A `403 unsupported_country_region_territory` is a server refusal, so proxy connectivity alone does not establish that sign-in is permitted.":
    "如需只代理本插件在 DSH 进程中发出的请求，可在 DSH 进程环境中设置 `DSH_CHATGPT_PROXY_URL=http://127.0.0.1:7897`，或在本插件的 profile 配置中设置 `proxyUrl`，然后重启 DSH。代理 URL 须为 HTTP 或 HTTPS。它覆盖 OAuth 换取/刷新 token、发现与撤销、模型列表和推理请求，不修改 DSH 全局网络设置，也不改变浏览器访问授权页的连接。代理必须能从运行 DSH 的机器访问；`127.0.0.1` 指的是那台机器。留空则直连。`403 unsupported_country_region_territory` 是服务端拒绝；代理能连通并不代表登录获得许可。",
  "An explicit profile `proxyUrl` takes precedence over `DSH_CHATGPT_PROXY_URL`; setting it to an empty string selects direct requests.":
    "显式配置的 profile `proxyUrl` 优先于 `DSH_CHATGPT_PROXY_URL`；将其设为空字符串会选择直连。",
  "A package installing without a `dsh.bundle` declaration activates no layer; `dsh plugin` warns instead.":
    "没有声明 `dsh.bundle` 的包不会激活任何层，`dsh plugin` 只会给出警告。",
  "### Sign in":
    "### 登录",
  "Open **Settings → Models**. The plugin owns a **ChatGPT** row, and the card on that row offers **Sign in with ChatGPT**. The card shows the authorization URL and selects it for copying, accepts the final redirect URL pasted back when the browser cannot reach the loopback address, and afterwards reports the account — its plan, the token's next refresh, and how many models it offers — with a **Sign out** button. No token reaches the page.":
    "打开**设置 → 模型**。本插件拥有一行 **ChatGPT**，该行的卡片提供 **Sign in with ChatGPT**。卡片会显示授权 URL 并支持选中复制；当浏览器无法访问回环地址时，可以粘贴最终的回调 URL；完成后卡片报告该账号——套餐、token 下次刷新时间、以及它提供多少个模型——并提供 **Sign out** 按钮。任何 token 都不会到达页面。",
  "Signing out revokes the renewable session at the authorization server before clearing it locally, and says so when the server did not confirm.":
    "退出登录会先在授权服务器撤销可再生会话，再清除本地凭据；若服务器未能确认，卡片会如实说明。",
  "![The ChatGPT row on the Models page, where the account signs in](assets/screenshot-2-models-page.png)":
    "![模型页上的 ChatGPT 行，账号从这里登录](../assets/screenshot-2-models-page.png)",
  "A headless harness drives the same session object with no browser at all:":
    "无头 harness 不需要浏览器，可以直接驱动同一个会话对象：",
  "The grant is stored owner-only under `stateDir`. `attempt.submit()` rejects a malformed or mismatched value and leaves the attempt open, so a mistyped paste can be corrected.":
    "授权凭据以仅属主可读的权限存放在 `stateDir` 下。`attempt.submit()` 对格式错误或不匹配的值会拒绝，并让本次尝试保持存活，所以粘贴错了可以改正重试。",
  "## What you get":
    "## 你会得到什么",
  "One provider route, listed in **Settings → Models** like any built-in provider. Existing SIWC models follow the account's catalog; the explicitly enabled Web model appears alongside them. Selecting a model there puts it in the normal model selector.":
    "一个 Provider 路由，像内置 Provider 一样出现在 **设置 → 模型** 中。现有 SIWC 模型跟随账号目录，显式启用的 Web 模型显示在同一处。在那里选择模型，就会将其加入普通模型选择器。",
  "For example, add this field to the plugin's configuration to set DSH's context budget to 1,000,000 tokens for models without an individual override, even if the catalog reports a maximum of 872,000. Remove it to restore account defaults for those models. These settings are independent of Codex settings. DSH still reserves headroom for compaction; they do not change service-side request limits.":
    "例如，在插件配置中加入以下字段，即可把没有单独配置的模型的 DSH 上下文预算设为 1,000,000 token，即使目录声明的最大值是 872,000 也不会缩小。删除此字段后，这些模型恢复账号默认值。这些设置与 Codex 配置相互独立。DSH 仍会为压缩预留空间；它们不会改变服务端的请求限制。",
  "For separate model budgets, use exact model IDs as dictionary keys. The priority is individual model, then global budget, then account default. In this example Astra uses 1,000,000, Sol uses 800,000, and other models use 500,000. The global field is optional; omit it to let other models follow their account defaults.":
    "单独配置模型预算时，以完整模型 ID 为字典键。优先级为指定模型配置、全局预算、账号默认值。下面的示例中，Astra 使用 1,000,000，Sol 使用 800,000，其余模型使用 500,000。全局字段是可选的；省略它可让其余模型跟随各自账号默认值。",
  "Changes take effect the next time DSH resolves a model. Removing a model entry restores the current global budget, or its account default when no global budget is set. Keys are case-sensitive exact IDs, not display names or wildcard patterns.":
    "修改会在 DSH 下次解析模型时生效。删除某个模型项后，该模型恢复当前全局预算；未设置全局预算时则恢复账号默认值。字典键按区分大小写的完整模型 ID 匹配，不使用显示名称或通配符。",
  "![The model picker listing the account's own models under a ChatGPT group](assets/screenshot-3-model-picker.png)":
    "![模型选择器里，账号自己的模型列在 ChatGPT 分组下](../assets/screenshot-3-model-picker.png)",
  "The share of the plan this installation may spend is set per app, in ChatGPT settings:":
    "这个安装可以花掉的套餐份额是在 ChatGPT 设置里按应用单独设定的：",
  "![The ChatGPT app's share of the plan, set per app in ChatGPT settings](assets/screenshot-4-app-limits.png)":
    "![该应用在套餐中的额度占比，在 ChatGPT 设置里逐应用设置](../assets/screenshot-4-app-limits.png)",
  "## Understand the implementation":
    "## 实现说明",
  "<summary>Implementation internals — click to expand</summary>":
    "<summary>实现细节 — 点击展开</summary>",
  "| Source | Responsibility |":
    "| 源码 | 职责 |",
  "| `cordis.patch.yml` | The layer: one inserted row naming the route and the state directory. |":
    "| `cordis.patch.yml` | 配置层：插入一行，指明路由与状态目录。 |",
  "| `src/index.ts` | The plugin entry: owns the adapter instance and registers the route. |":
    "| `src/index.ts` | 插件入口：持有适配器实例并注册路由。 |",
  "| `src/auth/protocol.ts` | The exact endpoints, scopes, and loopback rules of the published flow. |":
    "| `src/auth/protocol.ts` | 所公布流程的精确端点、scope 与 loopback 规则。 |",
  "| `src/auth/sign-in.ts` | Authorization: loopback listener and pasted redirect URL, raced. |":
    "| `src/auth/sign-in.ts` | 授权：loopback 监听与粘贴重定向 URL，两条路径并行竞争。 |",
  "| `src/auth/manager.ts` | Stored grants, the active account, and single-flight refresh. |":
    "| `src/auth/manager.ts` | 已存凭据、当前账号，以及单飞刷新。 |",
  "| `src/auth/store.ts` | Atomic, owner-only credential storage. |":
    "| `src/auth/store.ts` | 原子写、仅属主可读的凭据存储。 |",
  "| `src/api/events.ts` | Decoding the Responses event stream and its failure modes. |":
    "| `src/api/events.ts` | 解码 Responses 事件流及其失败形态。 |",
  "| `src/convert/request.ts` | Harness request to Responses body, including the fields the route refuses. |":
    "| `src/convert/request.ts` | Harness 请求转 Responses 请求体，含该路由拒收的字段。 |",
  "| `src/convert/harness.ts` | DSH request boundary, including session identity and replay metadata. |":
    "| `src/convert/harness.ts` | DSH 请求边界，含会话身份与回放元数据。 |",
  "| `src/convert/images.ts` | Resolve durable user/tool images, retain host offloads, reject unsupported content before inference. |":
    "| `src/convert/images.ts` | 解析用户/工具持久图片、保留宿主 offload 决策，在推理前拒绝不支持的内容。 |",
  "| `src/convert/replay.ts` | Validated native output and DSH replay envelopes, scoped to an account and model. |":
    "| `src/convert/replay.ts` | 原生输出校验及限定账号和模型的 DSH 回放封装。 |",
  "| `src/convert/blocks.ts` | Wire events to the harness's numbered content blocks. |":
    "| `src/convert/blocks.ts` | 线上事件转 Harness 的编号内容块。 |",
  "| `src/api/client.ts` | The two HTTP calls: list models, run one turn. |":
    "| `src/api/client.ts` | 两次 HTTP 调用：列出模型、跑一轮。 |",
  "| `src/models/describe.ts` | Availability and capacities, preferring what the account reports over the bundled catalog. |":
    "| `src/models/describe.ts` | 可用性与容量，优先采用账号所报的值而非内置目录。 |",
  "| `src/adapter.ts` | The harness-facing half of the provider contract. |":
    "| `src/adapter.ts` | provider 契约面向 Harness 的那一半。 |",
  "- A request never carries `temperature`, `max_output_tokens`, `top_p`, `truncation`, or the other fields the plan-usage route refuses. They are named in `REFUSED_FIELDS` so they cannot be reintroduced by accident.":
    "- 请求绝不携带 `temperature`、`max_output_tokens`、`top_p`、`truncation` 等套餐额度路由拒收的字段。它们被显式列在 `REFUSED_FIELDS` 中，因此不会被误加回来。",
  "- `response.completed` is the only successful terminal. A stream that ends without one is an error, because a truncated answer that reads as finished is worse than a visible failure.":
    "- `response.completed` 是唯一成功的终态。没有它就以结束的流算作错误，因为「被截断却看起来已完成」的回答比一个可见的失败更糟。",
  "- **Account metadata is read at run time.** The plugin requests `GET /v1/models` with the selected account's grant. The bundled catalog fills missing metadata, and the dated measured list can add unlisted models. Model availability and context capacity are separate from the context budget reported to DSH.":
    "- **运行时读取账号元数据。** 插件使用当前账号的授权请求 `GET /v1/models`。内置目录补充缺失的描述，带测量日期的清单可加入未列出的模型。模型可用性、容量和报告给 DSH 的上下文预算是不同的概念。",
  "## Further Exploration":
    "## 延伸阅读",
  "- [Sign in with ChatGPT: OSS token sharing](https://developers.openai.com/siwc/token-sharing-open-source) — the published flow this implements.":
    "- [Sign in with ChatGPT: OSS token sharing](https://developers.openai.com/siwc/token-sharing-open-source) — 本包所实现的公开流程。",
  "- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) — the listing and request constraints.":
    "- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) — 列表与请求约束。",
  "- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) — the capabilities this route does not have yet.":
    "- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) — 该路由目前尚不具备的能力。",
  "## Model Experience":
    "## 模型体验",
  "### Request context and condition":
    "### 请求上下文与条件",
  "#### What the model sees":
    "#### 模型能看到什么",
  "For every turn routed to `chatgpt`, the adapter preserves the order of messages, assistant blocks, tool calls, and results. System and developer instructions become developer messages at their original positions. DSH is told to append system-prompt updates in history. Native assistant output, including encrypted reasoning, is retained in DSH's `replayState` and replayed for the same authorization, route, and model when the saved content is unchanged.":
    "每轮发往 `chatgpt` 的请求都保留消息、助手内容块、工具调用及结果的原始顺序。system 与 developer 指令在原位置作为 developer 消息发送，并向 DSH 声明在历史中追加系统提示更新。助手的原生输出（含加密推理）通过 DSH 的 `replayState` 保存；授权、路由、模型一致且内容未变化时，完整回放这些数据。",
  "#### Token effect":
    "#### Token 影响",
  "Variable. Visible context comes from DSH. Replaying encrypted reasoning can also contribute input tokens; a readable reasoning summary is not a substitute. The adapter does not truncate history: DSH owns compaction using the reported context budget. Output reservations are kept below that budget, but this route does not accept an output-token cap.":
    "可变。可见上下文来自 DSH；回放加密推理也可能计入输入 token，可读的思考摘要不能替代它。适配器不自行截断历史，由 DSH 按报告的上下文预算执行压缩。输出预留保持低于该预算，但这条路由不接受输出 token 上限。",
  "#### KV Cache effect":
    "#### KV Cache 影响",
  "The adapter preserves reusable prefixes and opaque reasoning across tool turns and session restore. A bounded hash of the local authorization namespace, client registration, endpoint, provider, session ID, and call purpose supplies both `prompt_cache_key` and the `session_id` header; token refresh does not change it. Reauthorization gets a fresh namespace; legacy grants acquire one on first load. Sessionless calls omit these identifiers. OpenAI handles cache routing automatically on GPT-5.6 and later; a key is not a cache-hit guarantee. The SIWC route requires `store: false` and full HTTP history; response storage and prompt caching are separate. Cache retention/options remain omitted, as in Pi's public SIWC path, pending model-and-route-specific validation. See the [official caching guide](https://developers.openai.com/api/docs/guides/prompt-caching) and [reasoning replay guidance](https://developers.openai.com/api/docs/guides/reasoning#preserve-reasoning-without-stored-responses).":
    "适配器在多轮工具调用和会话恢复中保留可复用前缀及不透明推理状态。本地授权命名空间、client 注册、端点、provider、会话 ID 和调用用途的固定长度哈希同时用于 `prompt_cache_key` 与 `session_id` 请求头；刷新 token 不改变它。重新授权会生成新命名空间，旧凭据在首次读取时补齐；无会话 ID 的调用则省略两者。GPT-5.6 及以后由 OpenAI 自动处理缓存路由，key 不保证命中。SIWC 要求 `store: false` 并在 HTTP 请求中携带完整历史，响应存储与提示词缓存是两件事。与 Pi 的公共 SIWC 路线一样，这里继续省略缓存保留期与 options，等待按模型和路由验证。参见[官方缓存指南](https://developers.openai.com/api/docs/guides/prompt-caching)及[推理回放说明](https://developers.openai.com/api/docs/guides/reasoning#preserve-reasoning-without-stored-responses)。",
  "## Known Limitations and Deferred Work":
    "## 已知限制与待办",
  "- **Existing histories remain usable** — older sessions have no encrypted replay state to recover. Their visible messages and tools are replayed in order. Edited, pruned, foreign, malformed, or incompatible replay metadata falls back to visible history without reintroducing discarded content. This integration requires a DSH host supporting `finish.replayState` and `systemPromptUpdate: \"in-history\"`; see [the replay design and validation plan](docs/cache-replay.md).":
    "- **已有历史仍可使用** — 旧会话缺失的加密回放数据无法恢复，但可见消息和工具记录会按顺序回放。对于被编辑、裁剪、来自其他适配器、格式错误或不兼容的元数据，会退回可见历史，避免重新引入已丢弃内容。此集成要求 DSH 宿主支持 `finish.replayState` 和 `systemPromptUpdate: \"in-history\"`；参见[回放设计与验证方案](cache-replay.md)。",
  "- **One account at a time in the UI** — the host keeps every authorized account separate and can sign one out by subject, but the card shows and switches only the active account, so adding a second one means signing out first.":
    "- **UI 一次只展示一个账号** — 宿主为每个已授权账号分别保存，并可按 subject 退出其中任一个，但卡片只显示与切换当前账号，因此添加第二个账号需要先退出当前账号。",
  "- **Images require the host attachment service and a vision model** — user attachments and tool-result images, including PTC/LCU screenshots, are resolved to request-local bytes and sent as Responses image content. Tool results preserve their call ID, text/JSON, image order and error status. Explicit host image offloads remain text; unreadable attachments, unsupported roles/models and raw file blocks fail before inference. See the [content contract and local verification](docs/multimodal-content.md). Local request tests do not certify live image acceptance for a particular subscription account.":
    "- **图片需要宿主附件服务与视觉模型** — 用户附件及工具结果图片（包括 PTC/LCU 截图）会被解析为本次请求的字节，并作为 Responses 图片内容发送。工具结果保留 call ID、文本/JSON、图片顺序及错误状态。宿主明确 offload 的图片仍表示为文本；不可读取的附件、不支持的角色/模型及原始文件块会在推理请求前失败。参见[内容契约与本地验证](multimodal-content.md)。本地请求测试不认证某个订阅账号的在线图片接收能力。",
  "- **The plan-usage route is in preview** — computer use, Code Interpreter, file search, hosted MCP, image generation, and `tool_search` are refused upstream regardless of what this plugin sends, and `multi_agent`, `temperature`, and `max_output_tokens` are among fifteen fields that must be omitted.":
    "- **套餐额度路由仍处于 preview** — computer use、Code Interpreter、file search、hosted MCP、图像生成与 `tool_search` 无论本插件发送什么都会被上游拒绝；而 `multi_agent`、`temperature` 和 `max_output_tokens` 属于必须省略的十五个字段之列。",
  "- **The roster mixes two sources with different authority** — the account's listing supplies advertised models with the endpoint's own metadata; the models this route measurably serves but the listing omits are added from `src/models/served.ts`, dated by when they were measured. A listing that changes under a stale measurement will show extras that no longer answer, and `includeUnlisted: false` narrows the roster to the account's own answer.":
    "- **名单混合了两个权威性不同的来源** — 账号的列表提供「被宣传的」模型，并附带接口自己的元数据；实测可用但列表未提及的模型来自 `src/models/served.ts`，并记录测量日期。若列表在测量过期后发生变化，会显示出已经不再应答的额外模型；`includeUnlisted: false` 可把名单收窄为账号自己的回答。",
  "- **One installation, one host id** — the host id is scoped to the state directory. Two profiles sharing one directory are one installation to OpenAI; two directories are two, and each is consented separately.":
    "- **一个安装对应一个 host id** — host id 以状态目录为作用域。两个 profile 共用一个目录，对 OpenAI 而言就是一个安装；两个目录就是两个，各自需要单独授权。",
  "- **`agent_name_hint` is a constant** — it defaults to `DeepSeek Harness` and can be overridden per profile, but it is what a human reads on the consent screen and what OpenAI records as this app's identity, so changing it changes how existing grants are attributed.":
    "- **`agent_name_hint` 是常量** — 默认 `DeepSeek Harness`，可按 profile 覆盖；但它是人类在授权页上读到的名字，也是 OpenAI 记录的此应用身份，因此改动它会改变既有授权凭据的归属。",
  "- **Context growth has a configurable budget** — the default follows each model's account-catalog window, without a shared fixed cap. `contextWindowLimit` and every `modelContextWindowLimits` value must be safe integers of at least 1,024 tokens. Individual model values override the global value; both take precedence over catalog metadata without clamping, following Pi's override behavior. Without an override, missing account metadata uses the bundled fallback. DSH's own compaction policy controls the actual trigger and headroom. This is a context budget, not a hard spending limit or a cache-hit target.":
    "- **上下文增长受可配置预算约束** — 默认跟随各模型的账号目录窗口，不设置统一固定上限。`contextWindowLimit` 和 `modelContextWindowLimits` 中的每个值都必须是至少 1,024 的安全整数。指定模型值优先于全局值；参照 Pi 的覆盖逻辑，两者均优先于目录元数据，且不按目录最大值缩小。未显式配置且账号元数据缺失时，使用内置回退值。实际触发点与预留空间仍由 DSH 的压缩策略控制。这是上下文预算，不是消费硬上限或缓存命中目标。",
  "- **Signing out is two things, and the card says which happened** — the renewable session is revoked at the authorization server before the credential is cleared here, because a grant deleted locally may still be live elsewhere. When the server cannot be reached the sign-out still completes locally, and the outcome says the remote revocation was not confirmed. An exhausted allowance names ChatGPT's own usage page and says that the code identifies neither the cause nor a reset time: the plan's shared usage and an app-specific limit are both possible, which is why a plan that looks well within its limits on the site and a refusal can both be true.":
    "- **退出登录是两件事，卡片会说明发生了哪一件** — 可再生会话会先在授权服务器撤销，再清除本机凭据，因为本地删除的授权凭据可能在别处仍然有效。服务器无法送达时，本地登出仍然完成，而结果会明确说明远端撤销未被确认。额度耗尽时会指向 ChatGPT 自己的用量页面，并说明该错误码既不指明原因、也不给出重置时间：套餐的共享用量与应用级限制都可能是原因，因此网站上看起来远未接近上限的套餐与一次拒绝可以同时为真。",
  "- **Every Config field is `volatile()`, and that is load-bearing** — the harness builds a plugin's settings form from its volatile fields alone, and a plugin with none gets no settings namespace. The Models page renders a provider row only for a row whose namespace exists, so a schema without a volatile field leaves the route, and the card that rides it, impossible to display. Volatile fields are read through `.get()` at the point of use rather than captured as values.":
    "- **每个 Config 字段都是 `volatile()`，这是有实际作用的** — Harness 只根据 volatile 字段构建插件的 settings 表单，没有 volatile 字段的插件就不会有 settings 命名空间。而模型页只为命名空间存在的行渲染 provider 行，所以没有 volatile 字段的 schema 会让这条路由、以及依附其上的卡片，根本无法显示。volatile 字段在使用处以 `.get()` 读取，而不是被当作值捕获。",
  "- **The Client half mounts its own Remote namespace** — a bundled third-party plugin cannot reach `ctx.remote.<namespace>` on its own: the Gateway installs a namespace only from a contribution of generated descriptors, and the package carrying those for the shipped API packages is generated at build time from a fixed list of workspace packages. Nothing generates one for an out-of-tree package, and the generator is not published, so this plugin mounts the contribution itself from `src/remote-methods.ts`. A test reads the controller's source and fails when the two lists drift, because a method added on one side only would fail at the moment a user clicks.":
    "- **客户端半会自己挂载它的 Remote 命名空间** — 打包的第三方插件无法自行访问 `ctx.remote.<namespace>`：Gateway 只从生成出来的 descriptor contribution 安装命名空间，而承载这些内容的包是在构建期按固定的 workspace 包列表生成的。没有任何机制为树外包生成它，生成器也未发布，因此本插件在 `src/remote-methods.ts` 里自行挂载该 contribution。有测试会读取控制器源码，在两边列表不一致时失败——因为只在一边新增方法，会在用户点击的瞬间才报错。",
  "- **Signing in announces the new roster to the browser** — a model selector caches the Host catalog and reloads it only when the Host says something changed, so a plugin that fills an empty roster at sign-in time has to publish `llm/adapters-updated`. Without it the models are served and never appear in the selector, which looks exactly like a broken provider. The account card reports how many models the account offers, or why the listing could not be read.":
    "- **登录后会向浏览器通告新的模型清单** — 模型选择器会缓存宿主 catalog，只在宿主声明有变化时重载，因此在登录时把空清单填满的插件必须发布 `llm/adapters-updated`。否则模型确实在服务，却永远不会出现在选择器里——看起来就像 provider 坏了。账号卡片会报告该账号提供多少个模型，或说明清单为何读不到。",
  "- **Cache statistics are measured, not predicted** — the percentage is `cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)` using provider-reported counters. Earlier versions reordered tool history and dropped native reasoning; their low hit rates do not establish an inherent SIWC limit. Prefix-preservation tests do not measure live cache hits. Compare fixed-model, fixed-effort runs after warm-up, recording cache reads/writes, total input, latency, and quota impact.":
    "- **缓存统计来自实测，不作预测** — 百分比按服务端计数计算为 `cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)`。旧版本曾重排工具历史并丢弃原生推理，其低命中率不能证明 SIWC 存在固有上限。前缀保持测试不等于线上命中率测试；应固定模型与推理级别，预热后比较缓存读写、总输入、延迟和额度影响。",
  "- **Each installation registers its own client** — ChatGPT settings lists one app row per registration, named by `agent_name_hint`, and this plugin keeps the account/client mapping after signing out so the next sign-in on the same installation reuses its row instead of adding another. A second state directory is a second installation to OpenAI, and registers separately; deleting a state directory is what forgets one.":
    "- **每个安装各自注册一个 client** — ChatGPT 设置里每个注册对应一行应用，名称取自 `agent_name_hint`；本插件在登出后仍保留「账号 ↔ client」的映射，因此同一安装下次登录会复用原来那一行，而不是再添一行。第二个 state 目录对 OpenAI 而言就是第二个安装，会单独注册；删除某个 state 目录即等于忘记那个安装。",
  "`dev-types/` holds development-only declarations for the harness's LLM and Cordis seams, transcribed from the harness sources. They are not published and never shipped; the host supplies the real packages as peer dependencies. An end-to-end mount in a real harness remains the authoritative check.":
    "`dev-types/` 存放 Harness 的 LLM 与 Cordis 接缝的开发期声明，转录自 Harness 源码。它们不发布、也从不随包分发；宿主以 peer dependency 的形式提供真实包。在真实 Harness 中做端到端挂载仍然是权威的验证方式。",
  "Regenerate the model catalog when the upstream catalog moves:":
    "当上游目录更新时，重新生成模型目录：",
  "### Releasing":
    "### 发版",
  "A release is one tag: bump the version, push the tag, and the release workflow runs every check the CI lane runs, publishes only when the registry does not have that version yet, and records the GitHub Release either way.":
    "一次发版就是一个 tag：提版本、打 tag、推送。release 流水线会跑 CI 的全部检查，只在 registry 上还没有该版本时才发布，而无论是否发布都会记录 GitHub Release。",
  "Publishing takes either the repository's `NPM_TOKEN` secret or npm trusted publishing (workflow `release.yml`); the Release half uses the run's own token. Asking the registry first is what lets a tag for a version that was published by hand record its Release instead of failing, and what lets re-running a tag repair a missing Release. `workflow_dispatch` releases the manifest's version, creating the tag when it is absent.":
    "发布凭据走仓库的 `NPM_TOKEN` secret 或 npm 可信发布（工作流 `release.yml`）；Release 那一半用运行自带的 token。关键在「先问 registry」：它让手工发布过的版本在打 tag 时只补 Release 而不会失败，也让重跑同一个 tag 能修复缺失的 Release。`workflow_dispatch` 会发布 manifest 里的版本，并在 tag 不存在时自动创建。",
  "Adds one DeepSeek Harness provider route, `chatgpt`, for models served through your ChatGPT subscription. Existing subscription models use OpenAI's published *Sign in with ChatGPT* (SIWC) flow and the account's model catalog. The experimental **GPT-6 Pro · Web** model uses a separate dedicated browser connection. The route is named `chatgpt` because the built-in pi-ai plugin already owns `openai`.":
    "为 DeepSeek Harness 增加一个 Provider 路由 `chatgpt`，通过 ChatGPT 订阅使用模型。现有订阅模型采用 OpenAI 公布的 *Sign in with ChatGPT*（SIWC）流程和账号模型目录。实验性的 **GPT-6 Pro · Web** 模型使用独立的专用浏览器连接。路由命名为 `chatgpt`，因为内置 pi-ai 插件已占用 `openai`。",
  "- [Experimental ChatGPT Web Pro](#chatgpt-web-pro)":
    "- [实验性 ChatGPT Web Pro](#chatgpt-web-pro)",
  "## Experimental ChatGPT Web Pro":
    "## 实验性 ChatGPT Web Pro",
  "The `0.2.0-alpha.1` development candidate adds `chatgpt` / `gpt-6-pro-web` / `pro` to DSH's native model and effort controls. It is not yet published to npm. The Web model is disabled by default and requires the maintained, exact-base [DSH compatibility patch](compat/README.md) for commit `ca33fd6843b205e279c7ccb6cb73a472c78f5760` (`0.2.2-rc.4`); installing a plugin into a stock SDK does not supply those host extensions.":
    "`0.2.0-alpha.1` 开发候选版本将 `chatgpt` / `gpt-6-pro-web` / `pro` 接入 DSH 原生模型和档位控件，尚未发布到 npm。Web 模型默认关闭，需要针对 commit `ca33fd6843b205e279c7ccb6cb73a472c78f5760`（`0.2.2-rc.4`）维护的精确基线 [DSH 兼容补丁](../compat/README.zh.md)；只在原版 SDK 中安装插件不会补出这些宿主扩展。",
  "In the existing ChatGPT provider card, configure absolute paths for Chrome, a dedicated browser profile, and a separate private recovery directory. Save, click **Connect / verify login**, complete the website login manually in that browser, then click **Connect / verify login** again. Enable **GPT-6 Pro · Web** and select **Pro** in the normal model picker. This connection is independent of SIWC sign-in and its account-catalog models.":
    "在现有 ChatGPT Provider 卡片中，为 Chrome、专用浏览器 profile 和单独的私有恢复目录配置绝对路径。保存后点击 **Connect / verify login**，在该浏览器中手动完成网页登录，再次点击 **Connect / verify login**。启用 **GPT-6 Pro · Web**，并在普通模型选择器中选择 **Pro**。这条连接与 SIWC 登录及其账号目录模型相互独立。",
  "The default Web context is a private `project-only` project for each session generation. DSH owns local tools and permissions, validates complete structured responses before executing tools, and uses its single compaction engine with the Web pressure and summary policies. Compatible turns send incremental history; generation migration uses DSH's authoritative history. The model can serve planning, review, and execution roles according to each caller's permissions.":
    "默认 Web 上下文为每个会话代次独立的私有 `project-only` 项目。DSH 负责本地工具和权限，在执行工具前验证完整结构化响应，并让唯一压缩引擎使用 Web 压力与摘要策略。兼容轮次发送增量历史，代次迁移依据 DSH 的权威历史。模型可按调用方的权限用于规划、review 和执行角色。",
  "Interrupted Web work keeps separate dispatch, outcome, local cleanup, and remote-generation facts. Inspecting recovery sends no prompt and executes no tool. Explicitly adopting a captured response may execute its validated tools, but does not automatically request another model answer. Unknown remote or tool outcomes fence the execution domain; unknown website usage remains unknown.":
    "被中断的 Web 工作分别保留派发、结果、本地清理和远端生成事实。检查恢复不发送 prompt，也不执行工具。显式采纳已捕获响应可能执行其中已验证的工具，但不会自动请求下一次模型回答。远端或工具结果未知时阻断执行域；网页用量未知就保持 unknown。",
  "Real macOS, a signed-in ChatGPT account, and the current website layout have not completed acceptance. Media upload and automatic format repair are unavailable; ambiguous website full-context refusals and project creation remain conservatively blocked. See the complete [Web Pro setup, budgets, recovery, and validation boundaries](docs/web-pro.md) before enabling the candidate.":
    "真实 macOS、已登录 ChatGPT 账号和当前网页布局尚未完成验收。未提供媒体上传和自动格式修复；网页上下文已满或项目创建存在歧义时保守阻断。启用候选版本前，请阅读完整的 [Web Pro 设置、预算、恢复与验收边界](web-pro.zh.md)。",
  "For the existing SIWC models, metadata comes from the account listing. By default the adapter follows each model's advertised context window, including updates when the catalog refreshes. Set `contextWindowLimit` for a global budget or `modelContextWindowLimits` for individual models; explicit values are used as-is. Web Pro has a separate local byte policy described above. Sign-in lives on that row's card.":
    "现有 SIWC 模型的元数据来自账号目录。适配器默认跟随各模型声明的上下文窗口，并在目录刷新时采用更新值。可用 `contextWindowLimit` 设置全局预算，或用 `modelContextWindowLimits` 为指定模型设置预算，显式值按填写内容采用。Web Pro 使用上文所述的独立本地字节策略。登录仍在该行的卡片上。",
  "| `src/web/host.ts` and `src/web/integration.ts` | Web binding, execution-domain ownership, public DSH hooks, and recovery adoption. |":
    "| `src/web/host.ts` 与 `src/web/integration.ts` | Web 绑定、执行域归属、公共 DSH hooks 与恢复采纳。 |",
  "| `src/web/session-coordinator.ts` and `src/web/protocol.ts` | Incremental browser generations, durable delivery, and complete local-tool response validation. |":
    "| `src/web/session-coordinator.ts` 与 `src/web/protocol.ts` | 浏览器代次增量历史、持久交付与本地工具响应整包校验。 |",
  "| `src/web/transport.ts` and `src/web/browser/` | Dedicated Chrome control, observed activity, immutable response artifacts, and separate cleanup facts. |":
    "| `src/web/transport.ts` 与 `src/web/browser/` | 专用 Chrome 控制、实际活动、不可变响应 artifact 与独立清理事实。 |",
  "Three SIWC rules the code enforces rather than documents:":
    "代码实际强制的三条 SIWC 规则：",
  "The context and cache behavior in this section describes the existing SIWC models. This bundle inserts one provider row, and that row's plugin owns its model-facing behavior; the layer itself contributes no prompt, tool, or context. Web Pro uses the separate browser and structured-tool contract documented in its guide.":
    "本节的上下文与缓存行为描述现有 SIWC 模型。这个 bundle 插入一个 Provider 行，由该行的插件负责模型行为；配置层自身不增加 prompt、工具或上下文。Web Pro 使用独立的浏览器与结构化工具契约，详见其使用说明。",
  "- **Web Pro is an experimental, separately connected model** — its candidate, host-patch requirement, unknown usage, text-only input, recovery fences, and incomplete live acceptance are documented in the [Web Pro guide](docs/web-pro.md). SIWC context overrides, image support, proxy settings, and cache counters do not establish those capabilities for the Web route.":
    "- **Web Pro 是实验性的独立连接模型** — 其候选版本、宿主补丁要求、未知用量、纯文本输入、恢复阻断与未完成的真实验收均记录在 [Web Pro 使用说明](web-pro.zh.md)。SIWC 的上下文覆盖、图片支持、代理设置和缓存计数不能证明 Web 通道具备相同能力。",
}

/** Lines carried through unchanged: they hold no prose in either language. */
const STRUCTURAL = [
  /^---$/,
  /^kind: /,
  /^#+ /,
  /^-----$/,
  /^<a id=/,
  /^<\/a>$/,
  /^<details>$/,
  /^<\/details>$/,
  /^\|/,
  /^```/,
  /^$/,
]

/**
 * Build the Chinese page from the English one.
 * @param {string[]} english - the English lines.
 * @returns {string[]} the Chinese lines, structurally identical.
 */
function build(english) {
  const out = []
  let inFence = false
  const used = new Set()
  for (const line of english) {
    if (line.startsWith('```')) {
      inFence = !inFence
      out.push(line)
      continue
    }
    // Code blocks are byte-identical in both languages, comments included.
    if (inFence) {
      out.push(line)
      continue
    }
    if (Object.hasOwn(LINE_TRANSLATIONS, line)) {
      out.push(LINE_TRANSLATIONS[line])
      used.add(line)
      continue
    }
    if (STRUCTURAL.some(pattern => pattern.test(line))) {
      out.push(line)
      continue
    }
    throw new Error(`no translation for prose line: ${JSON.stringify(line)}`)
  }

  const unused = Object.keys(LINE_TRANSLATIONS).filter(line => !used.has(line))
  if (unused.length > 0) {
    throw new Error(
      `${unused.length} translation(s) match no English line (stale or mistyped):`
      + unused.map(line => `\n  ${JSON.stringify(line)}`).join(''),
    )
  }
  if (out.length !== english.length) {
    throw new Error(`line count drifted: ${english.length} English, ${out.length} Chinese`)
  }
  return out
}

const english = readFileSync(englishPath, 'utf8').replace(/\n$/, '').split('\n')
const chinese = build(english)

if (process.argv.includes('--check')) {
  const current = readFileSync(chinesePath, 'utf8').replace(/\n$/, '').split('\n')
  if (current.join('\n') !== chinese.join('\n')) {
    console.error('docs/README.zh.md is out of date; run: node scripts/align-readme-i18n.mjs')
    process.exit(1)
  }
  console.log(`README pair aligned: ${chinese.length} lines each`)
  process.exit(0)
}

writeFileSync(chinesePath, `${chinese.join('\n')}\n`, 'utf8')
console.log(`wrote docs/README.zh.md (${chinese.length} lines, matching README.md)`)
