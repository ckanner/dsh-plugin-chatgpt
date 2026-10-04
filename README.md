---
description: "Sign in with ChatGPT in DeepSeek Harness and serve models from a ChatGPT subscription instead of an API key."
kind: "package-bundle"
---

# dsh-plugin-chatgpt

English | [中文](README.zh.md)

## Summary

Adds one DeepSeek Harness provider route, `chatgpt`, that answers model calls from a signed-in ChatGPT subscription rather than an API key. Signing in uses OpenAI's published *Sign in with ChatGPT* flow, so the account's own plan pays for inference. The route is named `chatgpt` and not `openai` because the built-in pi-ai plugin already owns that name. Models, their context windows, and their reasoning levels come from your account's own listing, so the roster follows your plan rather than a hard-coded list.

## Table of Contents

- [Use this package](#use-this-package)
- [What you get](#what-you-get)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Install into a profile

```text
dsh plugin --profile <name> add dsh-plugin-chatgpt
dsh plugin --profile <name> remove dsh-plugin-chatgpt
```

The package declares `dsh.bundle`, so adding it appends the bundle to the profile's `dsh.profile.bundles` and its row is inserted into the composition. Verify the layer without booting:

```text
dsh --profile <name> --dump-config   # shows a "# == dsh-plugin-chatgpt" layer
```

A package installing without a `dsh.bundle` declaration activates no layer; `dsh plugin` warns instead. Installing from a git source also fetches sources rather than build output, so use a published version or a tarball from `npm pack` unless you intend to build it yourself.

### Sign in

Sign-in is not yet reachable from the Web UI — see [Known Limitations](#known-limitations-and-deferred-work). Until the account card lands, drive the flow from Node, which is also the shape the UI will use:

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

The grant is stored owner-only under `stateDir`. `attempt.submit()` rejects a malformed or mismatched value and leaves the attempt open, so a mistyped paste can be corrected.

-----

<a id="what-you-get"></a>
## What you get

One provider route, listed in **Settings → Models** like any built-in provider, with the model roster, context windows, and reasoning levels the account is entitled to. Selecting a model there is what puts it in the model selector; no separate picker is involved.

The account card that will own sign-in on that page is not built yet.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| Source | Responsibility |
|---|---|
| `cordis.patch.yml` | The layer: one inserted row naming the route and the state directory. |
| `src/index.ts` | The plugin entry: owns the adapter instance and registers the route. |
| `src/auth/protocol.ts` | The exact endpoints, scopes, and loopback rules of the published flow. |
| `src/auth/sign-in.ts` | Authorization: loopback listener and pasted redirect URL, raced. |
| `src/auth/manager.ts` | Stored grants, the active account, and single-flight refresh. |
| `src/auth/store.ts` | Atomic, owner-only credential storage. |
| `src/api/events.ts` | Decoding the Responses event stream and its failure modes. |
| `src/convert/request.ts` | Harness request to Responses body, including the fields the route refuses. |
| `src/convert/blocks.ts` | Wire events to the harness's numbered content blocks. |
| `src/client.ts` | The two HTTP calls: list models, run one turn. |
| `src/models/describe.ts` | Availability from the account, capacities from the bundled catalog. |
| `src/adapter.ts` | The harness-facing half of the provider contract. |

Two rules the code enforces rather than documents:

- A request never carries `temperature`, `max_output_tokens`, `top_p`, `truncation`, or the other fields the plan-usage route refuses. They are named in `REFUSED_FIELDS` so they cannot be reintroduced by accident.
- `response.completed` is the only successful terminal. A stream that ends without one is an error, because a truncated answer that reads as finished is worse than a visible failure.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Sign in with ChatGPT: OSS token sharing](https://developers.openai.com/siwc/token-sharing-open-source) — the published flow this implements.
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) — the listing and request constraints.
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) — the capabilities this route does not have yet.

-----

<a id="model-experience"></a>
## Model Experience

This bundle inserts one provider row, and that row's plugin owns all of its model-facing behaviour; the layer itself contributes no prompt, tool, or context of its own.

### Request context and condition

#### What the model sees

For every turn routed to the `chatgpt` provider: the conversation's messages, the system prompt lifted into the request's `instructions` field, any tool declarations the harness supplied, and the reasoning effort the harness selected. Nothing else is added.

#### Token effect

Variable. The plugin adds no tokens beyond what the harness already assembled; it translates and forwards.

#### KV Cache effect

Independent. Each turn is a separate request carrying its own context, and the plan-usage route does not accept `prompt_cache_retention` or `previous_response_id`, so this plugin neither builds nor preserves a reusable prefix.

## Known Limitations and Deferred Work

- **No Web UI sign-in** — the account card on the Models page is not built, so a grant must be created through the Node flow above. Until it exists the provider route is registered but unusable from the browser.
- **Images and files are not sent** — an image or file block carries a durable attachment reference that this adapter does not resolve, so it reaches the model as the placeholder text `[image omitted: not yet supported]`. The omission is visible rather than silent, but the content is genuinely lost.
- **The plan-usage route is in preview** — computer use, Code Interpreter, file search, hosted MCP, image generation, and `tool_search` are refused upstream regardless of what this plugin sends, and `multi_agent`, `temperature`, and `max_output_tokens` are among fifteen fields that must be omitted.
- **Model metadata is a bundled snapshot** — capacities and reasoning levels come from `src/models/catalog.json`, generated from the MIT-licensed pi-ai catalog. A model newer than that snapshot is still offered and callable but is marked `metadataSource: 'fallback'` and described with conservative defaults.
- **One installation, one host id** — the host id is scoped to the state directory. Two profiles sharing one directory are one installation to OpenAI; two directories are two, and each is consented separately.
- **`agent_name_hint` is a constant** — it defaults to `DeepSeek Harness` and can be overridden per profile, but it is what a human reads on the consent screen and what OpenAI records as this app's identity, so changing it changes how existing grants are attributed.

## Dev Note

```text
npm test          # node --test, no build step
npm run typecheck # entry point checked against dev-types/ shims
npm run build     # emits lib/ from src/, excluding the host-typed entry point
```

`dev-types/` holds development-only declarations for the harness's LLM and Cordis seams, transcribed from the harness sources. They are not published and never shipped; the host supplies the real packages as peer dependencies. An end-to-end mount in a real harness remains the authoritative check.

Regenerate the model catalog when the upstream catalog moves:

```text
node scripts/generate-model-catalog.mjs /path/to/@earendil-works/pi-ai
```
