/**
 * Regenerate `README.zh.md` from `README.md`, keeping the two pages line-for-line
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
 *   node scripts/align-readme-i18n.mjs           # rewrite README.zh.md
 *   node scripts/align-readme-i18n.mjs --check   # fail if the pair drifted
 *
 * @module dsh-plugin-chatgpt/scripts/align-readme-i18n
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const englishPath = join(here, '..', 'README.md')
const chinesePath = join(here, '..', 'README.zh.md')

/** Chinese text for each English line that carries prose, keyed exactly. */
const LINE_TRANSLATIONS = {
  "description: \"Sign in with ChatGPT in DeepSeek Harness and serve models from a ChatGPT subscription instead of an API key.\"":
    "description: \"在 DeepSeek Harness 里用 ChatGPT 账号登录，用 ChatGPT 订阅而不是 API key 来调用模型。\"",
  "English | [中文](README.zh.md)":
    "[English](README.md) | 中文",
  "Adds one DeepSeek Harness provider route, `chatgpt`, that answers model calls from a signed-in ChatGPT subscription rather than an API key. Signing in uses OpenAI's published *Sign in with ChatGPT* flow, so the account's own plan pays for inference. The route is named `chatgpt` and not `openai` because the built-in pi-ai plugin already owns that name. Models, their context windows, and their reasoning levels come from your account's own listing, so the roster follows your plan rather than a hard-coded list.":
    "为 DeepSeek Harness 增加一个 provider 路由 `chatgpt`，它用已登录的 ChatGPT 订阅而不是 API key 来应答模型调用。登录采用 OpenAI 公布的 *Sign in with ChatGPT* 流程，因此由账号自己的套餐为推理付费。路由命名为 `chatgpt` 而非 `openai`，因为内置的 pi-ai 插件已经占用了后者。模型及其上下文窗口与推理级别都来自你自己账号的列表，因此可选范围跟着套餐走，而不是一份写死的清单。",
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
  "The package declares `dsh.bundle`, so adding it appends the bundle to the profile's `dsh.profile.bundles` and its row is inserted into the composition. Verify the layer without booting:":
    "本包声明了 `dsh.bundle`，因此添加它会把该 bundle 追加到 profile 的 `dsh.profile.bundles`，并把它的行插入到组合中。可以不启动就检查这一层：",
  "A package installing without a `dsh.bundle` declaration activates no layer; `dsh plugin` warns instead. Installing from a git source also fetches sources rather than build output, so use a published version or a tarball from `npm pack` unless you intend to build it yourself.":
    "没有声明 `dsh.bundle` 的包不会激活任何层，`dsh plugin` 只会给出警告。从 git 源安装拿到的是源码而不是构建产物，因此除非你打算自己构建，否则请使用已发布的版本或 `npm pack` 生成的 tarball。",
  "### Sign in":
    "### 登录",
  "Sign-in is not yet reachable from the Web UI — see [Known Limitations](#known-limitations-and-deferred-work). Until the account card lands, drive the flow from Node, which is also the shape the UI will use:":
    "登录目前还无法从 Web UI 触发——见[已知限制](#known-limitations-and-deferred-work)。在账号卡片落地之前，用 Node 驱动该流程；这也正是 UI 将来使用的形态：",
  "The grant is stored owner-only under `stateDir`. `attempt.submit()` rejects a malformed or mismatched value and leaves the attempt open, so a mistyped paste can be corrected.":
    "授权凭据以仅属主可读的权限存放在 `stateDir` 下。`attempt.submit()` 对格式错误或不匹配的值会拒绝，并让本次尝试保持存活，所以粘贴错了可以改正重试。",
  "## What you get":
    "## 你会得到什么",
  "One provider route, listed in **Settings → Models** like any built-in provider, with the model roster, context windows, and reasoning levels the account is entitled to. Selecting a model there is what puts it in the model selector; no separate picker is involved.":
    "一个 provider 路由，像内置 provider 一样出现在 **设置 → 模型** 里，带有该账号有权使用的模型清单、上下文窗口和推理级别。在那里选中某个模型，就是把它放进模型选择器的方式，不涉及任何单独的挑选界面。",
  "Models, their capacities, and their reasoning levels all come from the account's own listing, which describes its models in more detail than the public documentation suggests: it reports a default context and a larger extended one, and asks for the extended one where it exists. The account card that will own sign-in on that page is not built yet.":
    "模型、容量与推理级别全部来自你自己账号的列表，而该接口对自己模型的描述比公开文档所写的详细得多：它会同时给出默认上下文与更大的扩展上下文，本插件在存在扩展值时按扩展值申报。该页面上将来负责登录的账号卡片尚未实现。",
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
  "| `src/convert/blocks.ts` | Wire events to the harness's numbered content blocks. |":
    "| `src/convert/blocks.ts` | 线上事件转 Harness 的编号内容块。 |",
  "| `src/client.ts` | The two HTTP calls: list models, run one turn. |":
    "| `src/client.ts` | 两次 HTTP 调用：列模型、跑一轮。 |",
  "| `src/models/describe.ts` | Availability from the account, capacities from the bundled catalog. |":
    "| `src/models/describe.ts` | 可用性来自账号，容量来自内置目录。 |",
  "| `src/adapter.ts` | The harness-facing half of the provider contract. |":
    "| `src/adapter.ts` | provider 契约面向 Harness 的那一半。 |",
  "Two rules the code enforces rather than documents:":
    "代码强制而非仅记录的两条规则：",
  "- A request never carries `temperature`, `max_output_tokens`, `top_p`, `truncation`, or the other fields the plan-usage route refuses. They are named in `REFUSED_FIELDS` so they cannot be reintroduced by accident.":
    "- 请求绝不携带 `temperature`、`max_output_tokens`、`top_p`、`truncation` 等套餐额度路由拒收的字段。它们被显式列在 `REFUSED_FIELDS` 中，因此不会被误加回来。",
  "- `response.completed` is the only successful terminal. A stream that ends without one is an error, because a truncated answer that reads as finished is worse than a visible failure.":
    "- `response.completed` 是唯一成功的终态。没有它就以结束的流算作错误，因为「被截断却看起来已完成」的回答比一个可见的失败更糟。",
  "- **The catalog is read at run time, not bundled.** pi-ai ships a static OpenAI catalog — forty-four ids at a fixed 272,000 context — and never asks the account what it has. Measured against a live Plus subscription, that static view is wrong in both directions: it omits models the route serves, and it understates the context the account is offered. This plugin asks `GET /v1/models` with the account's own grant, so entitlement, capacities, and reasoning levels come from the account rather than from a snapshot; the bundled catalog only describes a model the endpoint did not.":
    "- **目录是运行时读取的，不是内置的。** pi-ai 带一份静态 OpenAI 目录——44 个 id、上下文固定 272,000——从不问账号自己有什么。在真实 Plus 订阅上实测，这份静态视图两个方向都错：它漏掉该路线能服务的模型，又低估了账号实际获得的上下文。本插件用账号自己的授权请求 `GET /v1/models`，因此可用性、容量与推理级别都来自账号而不是快照；内置目录只用来描述接口没有描述的模型。",
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
  "This bundle inserts one provider row, and that row's plugin owns all of its model-facing behaviour; the layer itself contributes no prompt, tool, or context of its own.":
    "本 bundle 只插入一行 provider，该行的插件拥有全部面向模型的行为；配置层本身不贡献任何 prompt、工具或上下文。",
  "### Request context and condition":
    "### 请求上下文与条件",
  "#### What the model sees":
    "#### 模型能看到什么",
  "For every turn routed to the `chatgpt` provider: the conversation's messages, the system prompt lifted into the request's `instructions` field, any tool declarations the harness supplied, and the reasoning effort the harness selected. Nothing else is added.":
    "对于每一轮被路由到 `chatgpt` provider 的请求：对话消息、被提升到请求 `instructions` 字段的系统提示、Harness 提供的任何工具声明，以及 Harness 选定的推理级别。除此之外不添加任何内容。",
  "#### Token effect":
    "#### Token 影响",
  "Variable. The plugin adds no tokens beyond what the harness already assembled; it translates and forwards.":
    "可变。插件不添加超出 Harness 已经组装内容之外的 token；它只做转换与转发。",
  "#### KV Cache effect":
    "#### KV Cache 影响",
  "Independent. Each turn is a separate request carrying its own context, and the plan-usage route does not accept `prompt_cache_retention` or `previous_response_id`, so this plugin neither builds nor preserves a reusable prefix.":
    "相互独立。每轮都是携带自身上下文的一次独立请求，而套餐额度路由不接受 `prompt_cache_retention` 或 `previous_response_id`，因此本插件既不构建也不保留可复用的前缀。",
  "## Known Limitations and Deferred Work":
    "## 已知限制与待办",
  "- **No Web UI sign-in** — the account card on the Models page is not built, so a grant must be created through the Node flow above. Until it exists the provider route is registered but unusable from the browser.":
    "- **尚无 Web UI 登录** — 模型设置页上的账号卡片尚未实现，因此授权凭据必须通过上面的 Node 流程创建。在它出现之前，provider 路由虽已注册，但无法从浏览器使用。",
  "- **Images and files are not sent** — an image or file block carries a durable attachment reference that this adapter does not resolve, so it reaches the model as the placeholder text `[image omitted: not yet supported]`. The omission is visible rather than silent, but the content is genuinely lost.":
    "- **图片与文件不会被发送** — 图片或文件块携带的是持久化的附件引用，本适配器尚未解析它，因此到达模型时是占位文本 `[image omitted: not yet supported]`。该省略是可见的而非静默的，但内容确实丢失了。",
  "- **The plan-usage route is in preview** — computer use, Code Interpreter, file search, hosted MCP, image generation, and `tool_search` are refused upstream regardless of what this plugin sends, and `multi_agent`, `temperature`, and `max_output_tokens` are among fifteen fields that must be omitted.":
    "- **套餐额度路由仍处于 preview** — computer use、Code Interpreter、file search、hosted MCP、图像生成与 `tool_search` 无论本插件发送什么都会被上游拒绝；而 `multi_agent`、`temperature` 和 `max_output_tokens` 属于必须省略的十五个字段之列。",
  "- **The roster mixes two sources with different authority** — the account's listing supplies advertised models with the endpoint's own metadata; the models this route measurably serves but the listing omits are added from `src/models/served.ts`, dated by when they were measured. A listing that changes under a stale measurement will show extras that no longer answer, and `includeUnlisted: false` narrows the roster to the account's own answer.":
    "- **名单混合了两个权威性不同的来源** — 账号的列表提供「被宣传的」模型，并附带接口自己的元数据；实测可用但列表未提及的模型来自 `src/models/served.ts`，并记录测量日期。若列表在测量过期后发生变化，会显示出已经不再应答的额外模型；`includeUnlisted: false` 可把名单收窄为账号自己的回答。",
  "- **One installation, one host id** — the host id is scoped to the state directory. Two profiles sharing one directory are one installation to OpenAI; two directories are two, and each is consented separately.":
    "- **一个安装对应一个 host id** — host id 以状态目录为作用域。两个 profile 共用一个目录，对 OpenAI 而言就是一个安装；两个目录就是两个，各自需要单独授权。",
  "- **`agent_name_hint` is a constant** — it defaults to `DeepSeek Harness` and can be overridden per profile, but it is what a human reads on the consent screen and what OpenAI records as this app's identity, so changing it changes how existing grants are attributed.":
    "- **`agent_name_hint` 是常量** — 默认 `DeepSeek Harness`，可按 profile 覆盖；但它是人类在授权页上读到的名字，也是 OpenAI 记录的此应用身份，因此改动它会改变既有授权凭据的归属。",
  "- **Context is capped by the served catalog, below the model spec** — the public model pages advertise 1,050,000 tokens, and the account's listing reports a default of 272,000 with an extended 872,000, which is what this adapter uses. The larger figure is not reachable through this surface today, and a client that identifies itself as a coding tool receives 272,000 instead of 872,000. Models added from the measured list have no listing entry, so they are reported at the catalog's 272,000.":
    "- **上下文受服务端目录限制，低于模型规格** — 公开模型页宣传 1,050,000 token，而账号的列表报告默认 272,000、扩展 872,000，本适配器采用后者。该更大的数值今天无法通过这条通道取到，而把自身标识为编码工具的工具会拿到 272,000 而不是 872,000。来自实测名单的模型没有列表条目，因此按目录的 272,000 报告。",
  "- **Signing out is two things, and the card says which happened** — the renewable session is revoked at the authorization server before the credential is cleared here, because a grant deleted locally may still be live elsewhere. When the server cannot be reached the sign-out still completes locally, and the outcome says the remote revocation was not confirmed. An exhausted allowance names ChatGPT's own usage page, since an app-specific limit can apply while the plan itself still has usage.":
    "- **退出登录是两件事，卡片会说明发生了哪一件** — 可再生会话会先在授权服务器撤销，再清除本机凭据，因为本地删除的授权凭据可能在别处仍然有效。服务器无法送达时，本地登出仍然完成，而结果会明确说明远端撤销未被确认。额度耗尽时会指向 ChatGPT 自己的用量页面，因为即使套餐本身仍有额度，应用级上限也可能生效。",
  "- **Every Config field is `volatile()`, and that is load-bearing** — the harness builds a plugin's settings form from its volatile fields alone, and a plugin with none gets no settings namespace. The Models page renders a provider row only for a row whose namespace exists, so a schema without a volatile field leaves the route, and the card that rides it, impossible to display. Volatile fields are read through `.get()` at the point of use rather than captured as values.":
    "- **每个 Config 字段都是 `volatile()`，这是有实际作用的** — Harness 只根据 volatile 字段构建插件的 settings 表单，没有 volatile 字段的插件就不会有 settings 命名空间。而模型页只为命名空间存在的行渲染 provider 行，所以没有 volatile 字段的 schema 会让这条路由、以及依附其上的卡片，根本无法显示。volatile 字段在使用处以 `.get()` 读取，而不是被当作值捕获。",
  "- **The Client half mounts its own Remote namespace** — a bundled third-party plugin cannot reach `ctx.remote.<namespace>` on its own: the Gateway installs a namespace only from a contribution of generated descriptors, and the package carrying those for the shipped API packages is generated at build time from a fixed list of workspace packages. Nothing generates one for an out-of-tree package, and the generator is not published, so this plugin mounts the contribution itself from `src/remote-methods.ts`. A test reads the controller's source and fails when the two lists drift, because a method added on one side only would fail at the moment a user clicks.":
    "- **客户端半会自己挂载它的 Remote 命名空间** — 打包的第三方插件无法自行访问 `ctx.remote.<namespace>`：Gateway 只从生成出来的 descriptor contribution 安装命名空间，而承载这些内容的包是在构建期按固定的 workspace 包列表生成的。没有任何机制为树外包生成它，生成器也未发布，因此本插件在 `src/remote-methods.ts` 里自行挂载该 contribution。有测试会读取控制器源码，在两边列表不一致时失败——因为只在一边新增方法，会在用户点击的瞬间才报错。",
  "- **Signing in announces the new roster to the browser** — a model selector caches the Host catalog and reloads it only when the Host says something changed, so a plugin that fills an empty roster at sign-in time has to publish `llm/adapters-updated`. Without it the models are served and never appear in the selector, which looks exactly like a broken provider. The account card reports how many models the account offers, or why the listing could not be read.":
    "- **登录后会向浏览器通告新的模型清单** — 模型选择器会缓存宿主 catalog，只在宿主声明有变化时重载，因此在登录时把空清单填满的插件必须发布 `llm/adapters-updated`。否则模型确实在服务，却永远不会出现在选择器里——看起来就像 provider 坏了。账号卡片会报告该账号提供多少个模型，或说明清单为何读不到。",
  "- **The cache-hit readout is zero on this route, and that is the honest value** — the composer's percentage is `cacheReadTokens / billed input`, and the numerator comes only from what the endpoint reports in `input_tokens_details.cached_tokens`. This flow mandates `store: false` and refuses `prompt_cache_retention`, and the endpoint reports zero cached tokens even for a 10,814-token prompt sent three times unchanged in immediate succession — which is the best case a cache key could improve on. The rest of that readout (rate, totals, context share) is real.":
    "- **这条路由上缓存命中率就是 0，而这正是如实的值** — composer 的百分比是 `cacheReadTokens / 计费输入`，分子只来自端点返回的 `input_tokens_details.cached_tokens`。该流程强制 `store: false` 且拒收 `prompt_cache_retention`；而端点对一个 10,814 token 的提示词**连发三次且完全不变**，返回的缓存 token 仍是 0——这已经是缓存键能改善的最好情况了。该栏其余数字（速率、总量、上下文占比）都是真实的。",
  "## Dev Note":
    "## Dev Note",
  "`dev-types/` holds development-only declarations for the harness's LLM and Cordis seams, transcribed from the harness sources. They are not published and never shipped; the host supplies the real packages as peer dependencies. An end-to-end mount in a real harness remains the authoritative check.":
    "`dev-types/` 存放 Harness 的 LLM 与 Cordis 接缝的开发期声明，转录自 Harness 源码。它们不发布、也从不随包分发；宿主以 peer dependency 的形式提供真实包。在真实 Harness 中做端到端挂载仍然是权威的验证方式。",
  "Regenerate the model catalog when the upstream catalog moves:":
    "当上游目录更新时，重新生成模型目录：",
  "![The ChatGPT provider row on the Models page, signed out, with a Sign in with ChatGPT button](assets/screenshot-1-sign-in.png)":
    "![模型页上的 ChatGPT provider 行，处于已登出状态，带有一个 Sign in with ChatGPT 按钮](assets/screenshot-1-sign-in.png)",
  "![A turn running on the subscription: the composer shows GPT-6.1 Sol Max and the usage bar reports its tokens and rate](assets/screenshot-2-serving-models.png)":
    "![一轮跑在订阅上的对话：composer 显示 GPT-6.1 Sol Max，用量栏报告其 token 与速率](assets/screenshot-2-serving-models.png)",
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
    console.error('README.zh.md is out of date; run: node scripts/align-readme-i18n.mjs')
    process.exit(1)
  }
  console.log(`README pair aligned: ${chinese.length} lines each`)
  process.exit(0)
}

writeFileSync(chinesePath, `${chinese.join('\n')}\n`, 'utf8')
console.log(`wrote README.zh.md (${chinese.length} lines, matching README.md)`)
