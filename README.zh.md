---
description: "在 DeepSeek Harness 里用 ChatGPT 账号登录，用 ChatGPT 订阅而不是 API key 来调用模型。"
kind: "package-bundle"
---

# dsh-plugin-chatgpt

[English](README.md) | 中文

## Summary

为 DeepSeek Harness 增加一个 provider 路由 `chatgpt`，它用已登录的 ChatGPT 订阅而不是 API key 来应答模型调用。登录采用 OpenAI 公布的 *Sign in with ChatGPT* 流程，因此由账号自己的套餐为推理付费。路由命名为 `chatgpt` 而非 `openai`，因为内置的 pi-ai 插件已经占用了后者。模型及其上下文窗口与推理级别都来自你自己账号的列表，因此可选范围跟着套餐走，而不是一份写死的清单。

## Table of Contents

- [使用本包](#use-this-package)
- [你会得到什么](#what-you-get)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发者说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 安装到 profile

```text
dsh plugin --profile <name> add dsh-plugin-chatgpt
dsh plugin --profile <name> remove dsh-plugin-chatgpt
```

本包声明了 `dsh.bundle`，因此添加它会把该 bundle 追加到 profile 的 `dsh.profile.bundles`，并把它的行插入到组合中。可以不启动就检查这一层：

```text
dsh --profile <name> --dump-config   # shows a "# == dsh-plugin-chatgpt" layer
```

没有声明 `dsh.bundle` 的包不会激活任何层，`dsh plugin` 只会给出警告。从 git 源安装拿到的是源码而不是构建产物，因此除非你打算自己构建，否则请使用已发布的版本或 `npm pack` 生成的 tarball。

### 登录

登录目前还无法从 Web UI 触发——见[已知限制](#known-limitations-and-deferred-work)。在账号卡片落地之前，用 Node 驱动该流程；这也正是 UI 将来使用的形态：

```js
import { ChatGptAuth } from 'dsh-plugin-chatgpt/src/auth/manager.ts'

const auth = new ChatGptAuth({
  stateDir: `${process.env.DSH_HOME ?? `${process.env.HOME}/.dsh`}/chatgpt-subscription`,
  agentNameHint: 'DeepSeek Harness',
})

const attempt = await auth.begin()
console.log('Open this URL in your browser:\n' + attempt.authorizationUrl)

// The browser redirects to the loopback listener this attempt bound. If the
// redirect cannot reach it — a headless host, or a blocked popup — paste the
// final URL back instead.
// await attempt.submit('<the full redirect URL from your browser>')

const credential = await attempt.result
auth.adopt(credential)
```

授权凭据以仅属主可读的权限存放在 `stateDir` 下。`attempt.submit()` 对格式错误或不匹配的值会拒绝，并让本次尝试保持存活，所以粘贴错了可以改正重试。

-----

<a id="what-you-get"></a>
## 你会得到什么

一个 provider 路由，像内置 provider 一样出现在 **设置 → 模型** 里，带有该账号有权使用的模型清单、上下文窗口和推理级别。在那里选中某个模型，就是把它放进模型选择器的方式，不涉及任何单独的挑选界面。

模型、容量与推理级别全部来自你自己账号的列表，而该接口对自己模型的描述比公开文档所写的详细得多：它会同时给出默认上下文与更大的扩展上下文，本插件在存在扩展值时按扩展值申报。该页面上将来负责登录的账号卡片尚未实现。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节 — 点击展开</summary>

| 源码 | 职责 |
|---|---|
| `cordis.patch.yml` | 配置层：插入一行，指明路由与状态目录。 |
| `src/index.ts` | 插件入口：持有适配器实例并注册路由。 |
| `src/auth/protocol.ts` | 所公布流程的精确端点、scope 与 loopback 规则。 |
| `src/auth/sign-in.ts` | 授权：loopback 监听与粘贴重定向 URL，两条路径并行竞争。 |
| `src/auth/manager.ts` | 已存凭据、当前账号，以及单飞刷新。 |
| `src/auth/store.ts` | 原子写、仅属主可读的凭据存储。 |
| `src/api/events.ts` | 解码 Responses 事件流及其失败形态。 |
| `src/convert/request.ts` | Harness 请求转 Responses 请求体，含该路由拒收的字段。 |
| `src/convert/blocks.ts` | 线上事件转 Harness 的编号内容块。 |
| `src/client.ts` | 两次 HTTP 调用：列模型、跑一轮。 |
| `src/models/describe.ts` | 可用性来自账号，容量来自内置目录。 |
| `src/adapter.ts` | provider 契约面向 Harness 的那一半。 |

代码强制而非仅记录的两条规则：

- 请求绝不携带 `temperature`、`max_output_tokens`、`top_p`、`truncation` 等套餐额度路由拒收的字段。它们被显式列在 `REFUSED_FIELDS` 中，因此不会被误加回来。
- `response.completed` 是唯一成功的终态。没有它就以结束的流算作错误，因为「被截断却看起来已完成」的回答比一个可见的失败更糟。
- **目录是运行时读取的，不是内置的。** pi-ai 带一份静态 OpenAI 目录——44 个 id、上下文固定 272,000——从不问账号自己有什么。在真实 Plus 订阅上实测，这份静态视图两个方向都错：它漏掉该路线能服务的模型，又低估了账号实际获得的上下文。本插件用账号自己的授权请求 `GET /v1/models`，因此可用性、容量与推理级别都来自账号而不是快照；内置目录只用来描述接口没有描述的模型。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Sign in with ChatGPT: OSS token sharing](https://developers.openai.com/siwc/token-sharing-open-source) — 本包所实现的公开流程。
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) — 列表与请求约束。
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) — 该路由目前尚不具备的能力。

-----

<a id="model-experience"></a>
## 模型体验

本 bundle 只插入一行 provider，该行的插件拥有全部面向模型的行为；配置层本身不贡献任何 prompt、工具或上下文。

### 请求上下文与条件

#### 模型能看到什么

对于每一轮被路由到 `chatgpt` provider 的请求：对话消息、被提升到请求 `instructions` 字段的系统提示、Harness 提供的任何工具声明，以及 Harness 选定的推理级别。除此之外不添加任何内容。

#### Token 影响

可变。插件不添加超出 Harness 已经组装内容之外的 token；它只做转换与转发。

#### KV Cache 影响

相互独立。每轮都是携带自身上下文的一次独立请求，而套餐额度路由不接受 `prompt_cache_retention` 或 `previous_response_id`，因此本插件既不构建也不保留可复用的前缀。

## 已知限制与待办

- **尚无 Web UI 登录** — 模型设置页上的账号卡片尚未实现，因此授权凭据必须通过上面的 Node 流程创建。在它出现之前，provider 路由虽已注册，但无法从浏览器使用。
- **图片与文件不会被发送** — 图片或文件块携带的是持久化的附件引用，本适配器尚未解析它，因此到达模型时是占位文本 `[image omitted: not yet supported]`。该省略是可见的而非静默的，但内容确实丢失了。
- **套餐额度路由仍处于 preview** — computer use、Code Interpreter、file search、hosted MCP、图像生成与 `tool_search` 无论本插件发送什么都会被上游拒绝；而 `multi_agent`、`temperature` 和 `max_output_tokens` 属于必须省略的十五个字段之列。
- **名单混合了两个权威性不同的来源** — 账号的列表提供「被宣传的」模型，并附带接口自己的元数据；实测可用但列表未提及的模型来自 `src/models/served.ts`，并记录测量日期。若列表在测量过期后发生变化，会显示出已经不再应答的额外模型；`includeUnlisted: false` 可把名单收窄为账号自己的回答。
- **一个安装对应一个 host id** — host id 以状态目录为作用域。两个 profile 共用一个目录，对 OpenAI 而言就是一个安装；两个目录就是两个，各自需要单独授权。
- **`agent_name_hint` 是常量** — 默认 `DeepSeek Harness`，可按 profile 覆盖；但它是人类在授权页上读到的名字，也是 OpenAI 记录的此应用身份，因此改动它会改变既有授权凭据的归属。

- **上下文受服务端目录限制，低于模型规格** — 公开模型页宣传 1,050,000 token，而账号的列表报告默认 272,000、扩展 872,000，本适配器采用后者。该更大的数值今天无法通过这条通道取到，而把自身标识为编码工具的工具会拿到 272,000 而不是 872,000。来自实测名单的模型没有列表条目，因此按目录的 272,000 报告。

- **退出登录是两件事，卡片会说明发生了哪一件** — 可再生会话会先在授权服务器撤销，再清除本机凭据，因为本地删除的授权凭据可能在别处仍然有效。服务器无法送达时，本地登出仍然完成，而结果会明确说明远端撤销未被确认。额度耗尽时会指向 ChatGPT 自己的用量页面，因为即使套餐本身仍有额度，应用级上限也可能生效。

- **每个 Config 字段都是 `volatile()`，这是有实际作用的** — Harness 只根据 volatile 字段构建插件的 settings 表单，没有 volatile 字段的插件就不会有 settings 命名空间。而模型页只为命名空间存在的行渲染 provider 行，所以没有 volatile 字段的 schema 会让这条路由、以及依附其上的卡片，根本无法显示。volatile 字段在使用处以 `.get()` 读取，而不是被当作值捕获。

## Dev Note

```text
npm test          # node --test, no build step
npm run typecheck # entry point checked against dev-types/ shims
npm run build     # emits lib/ from src/, excluding the host-typed entry point
```

`dev-types/` 存放 Harness 的 LLM 与 Cordis 接缝的开发期声明，转录自 Harness 源码。它们不发布、也从不随包分发；宿主以 peer dependency 的形式提供真实包。在真实 Harness 中做端到端挂载仍然是权威的验证方式。

当上游目录更新时，重新生成模型目录：

```text
node scripts/generate-model-catalog.mjs /path/to/@earendil-works/pi-ai
```
