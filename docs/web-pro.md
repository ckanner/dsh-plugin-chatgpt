# ChatGPT Web Pro

English | [中文](web-pro.zh.md)

This candidate adds **GPT-6 Pro · Web** to DSH's native model selector under the existing `chatgpt` provider. It drives a dedicated, signed-in ChatGPT browser connection. DSH continues to own the conversation, local tools, permissions, and compaction; the browser supplies the model's answers.

**Release status:** `0.2.0-alpha.1` is a development candidate, not a published npm release. Web calls require the maintained DSH compatibility patch described below. Real macOS, a signed-in ChatGPT account, and the current website layout have not completed acceptance testing. Offline fixtures establish implementation behavior, not live account availability.

## 1. Select the exact model

| Setting | Value |
|---|---|
| Provider | `chatgpt`, unless this installation explicitly renamed the provider route |
| Model ID | `gpt-6-pro-web` |
| Model label | `GPT-6 Pro · Web` |
| Reasoning effort | `pro`; displayed as **Pro** |
| Transport | `chatgpt-web` |
| Default hosted context | `project-only` |

`gpt-6-pro-web` is this plugin's model identifier. It is not an OpenAI API model name. The browser adapter verifies the website's **GPT-6** and **Pro** controls for the owned conversation. An unavailable or unrecognized control stops admission; the plugin does not translate `pro` into another model or effort.

Use this model wherever a compatible DSH caller accepts a provider/model/effort binding: a normal conversation, planning, review, or an execution loop with local tools. The caller still determines which tools and permissions that role receives. A stronger model selection does not grant additional permissions.

## 2. Two connections on one provider row

| Property | Existing subscription models | GPT-6 Pro · Web |
|---|---|---|
| Connection | Sign in with ChatGPT, or SIWC | Dedicated Chrome profile with manual website login |
| Model discovery | Account catalog and the existing SIWC metadata policy | Explicit Web model, enabled in the provider card |
| Credentials | Plugin-managed SIWC grant | Browser-managed website login; separately observed account fingerprint |
| Context budget | SIWC model metadata and its configured overrides | Local Web byte policy plus the host's compaction policy |
| Images | The existing SIWC attachment/vision contract | Unavailable in this candidate; original image/file blocks are rejected |
| Usage | Counters reported by the SIWC route | Unknown when the website provides no authoritative counters |

Signing in or out of SIWC does not sign the dedicated browser in or out. SIWC's `contextWindowLimit`, `modelContextWindowLimits`, and server-side `proxyUrl` do not configure Web context or Chrome networking. An enabled Web model can appear in the picker before its browser account is connected; discovery is not a live readiness check.

This implementation owns its browser transport and recovery protocol. It does not invoke Oracle at runtime, borrow an unrelated personal browser tab, or expose an official OpenAI machine API for the website.

## 3. Install a compatible host and this candidate

Follow [the compatibility installation guide](../compat/README.md). The maintained patch is [dsh-web-host-ca33fd68.patch](../compat/dsh-web-host-ca33fd68.patch), with its base and verification metadata in [manifest.json](../compat/manifest.json).

The exact DSH base is:

```text
ca33fd6843b205e279c7ccb6cb73a472c78f5760
0.2.2-rc.4
```

Apply the patch to an isolated checkout at that commit and build/run the resulting host as the compatibility guide describes. The version string alone does not establish compatibility. Installing this plugin into a stock SDK or Desktop build does not add the missing host hooks.

Web admission requires version 1 of `replayVeto`, `durableResponseAck`, `summaryRoute`, `durableSummaryAck`, and `pressurePolicy`. Explicit recovery adoption additionally requires the matching `recoveredResponse` or `recoveredSummary` capability. Missing required capabilities cause a pre-dispatch error. Ordinary SIWC operation keeps its existing host requirements.

Build a local candidate from this plugin checkout:

```sh
npm ci
npm run build
npm pack
```

Install the resulting local archive into the profile used by the patched host:

```text
dsh plugin --profile <name> add /absolute/path/dsh-plugin-chatgpt-0.2.0-alpha.1.tgz
dsh --profile <name> --dump-config
```

Use the patched host's CLI for these commands and restart that host after changing its profile. Check that the composition includes this plugin and one active DSH compaction engine. The registry installation commands in the main README describe the published SIWC package; they do not establish that this Web candidate or the compatibility host has been published.

## 4. Connect the dedicated browser

1. Open **Settings → Models → ChatGPT** and find **ChatGPT Web · GPT-6 / Pro**.
2. Set an absolute **Chrome executable** path, a dedicated **browser profile** directory, and a separate private **recovery directory**. Save the settings before connecting. Do not point these fields at a personal Chrome profile, your home directory, or a shared directory.
3. Leave **Conversation context** at **Private project-only workspace**. Enable the Web model and save.
4. Click **Connect / verify login**. The plugin opens its dedicated Chrome login surface without sending a prompt or creating a project. Complete the website's normal login manually in that window.
5. Click **Connect / verify login** again after login. The plugin observes and binds the dedicated account. A later account mismatch is an error; it does not silently rebind the connection.
6. In DSH's normal model picker, select **GPT-6 Pro · Web**, then **Pro**. Start with a small, low-impact task in the workspace and permission mode you intend to use.

On macOS the default executable is `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`; on Linux it is `/usr/bin/google-chrome`. Set the actual absolute executable path when your installation differs. The default directories are `<plugin stateDir>/web-browser` and `<plugin stateDir>/web-runtime`. A literal `~` is not an absolute path.

The normal card-managed settings are stored privately. An explicit `web` object in the DSH profile takes precedence; edit that profile for configuration changes. Its account fingerprint must come from the observed dedicated account. Do not copy SIWC credentials into Web fields or invent a fingerprint to bypass connection verification.

For a profile-managed connection, **Save Web settings** is disabled. Connect verifies an already bound account without rewriting the profile. If its fingerprint is empty, Connect displays the observed hash: put that value in `web.connections[web.activeConnection].accountFingerprint` in the owning profile, reload its configuration, then Connect again. The card does not overwrite profile-owned settings. Completed calls appear under **Recent Web conversations** with links to their owned chats.

The **Account: Bound** indicator means an account identity has been stored. **Required extensions present** describes the host contract. Neither certifies the website's current model availability or layout. The adapter checks account, model, effort, and hosted context again for actual calls.

## 5. Hosted context and local execution

The default managed mode creates a new private, project-only ChatGPT project for each logical session generation. Main calls, subagents, and auxiliary calls have distinct conversation ownership; an auxiliary summary or title does not append to the main conversation. Admission checks include the account, project-only setting, project instructions and sources, sharing state, model, effort, and the conversation's parent project.

Failure to verify those conditions stops the call. Managed mode does not fall back to a personalized home-page chat or change the user's global account preferences. **Personalized chat** is an explicit setting for ordinary interactive use. It may include context from outside DSH and is unsuitable for a caller that requires independent review; Flywheel's managed Web binding requires `project-only`.

The model returns a plugin-defined JSON envelope containing either final text or a batch of local tool calls. Before exposing any tool call, the plugin validates the complete response, request and generation identity, duplicate keys, nesting, call IDs, tool names, and every argument against the admitted JSON Schema. A malformed batch executes no partial subset of its tools.

DSH executes accepted tools through its normal tool runtime, working directory, sandbox, and permissions. The website does not directly execute those local tools. Hosted website apps are a separate capability and must satisfy the managed-context checks; local sandbox settings are not evidence about remote app behavior. This candidate provides no automatic format-repair request when the envelope is invalid.

Readable project/conversation titles are derived locally from the task and generation; setting them does not spend another Pro call. User-changed owned titles are preserved when the adapter can identify the change. If the DSH profile enables model-generated session titles, those remain separate auxiliary model calls.

## 6. Long conversations and compaction

DSH's durable event history is the source of truth. Within a compatible generation, the plugin sends the new authoritative suffix instead of resending the full conversation at every tool turn. Prefix, system, tool-registry, connection, policy, and generation checks prevent unrelated history from being appended to an existing browser conversation.

Local history/turn pressure or a changed authoritative prefix can require a new browser generation. The next generation receives a bounded bootstrap from DSH's current history. A move cannot erase unresolved remote dispatch, uncommitted responses, or uncertain tool outcomes.

There is **one DSH compaction engine**. The plugin contributes the Web summary route and `compaction/pressure-policy`; it does not run a second hidden summarizer. Automatic and manual compaction use the host's public transaction and durable summary acknowledgement. When the selected summary target is this Web model, the summary uses **Pro** in an independent auxiliary conversation. An explicitly configured different summary model keeps its own route and accounting.

The complete serialized prompt, including protocol and tool-schema overhead, must fit the Web byte policy before browser dispatch. A single input that cannot be safely compacted or split is rejected. Compaction is lossy, and changing browser conversations does not reset the account's quota or create an unlimited context window.

### Default local policy

| Field | Default | Meaning |
|---|---|---|
| `maxInputBytes` | 96 KiB | Input envelope including the reserved output allowance |
| `outputReserveBytes` | 32 KiB | Leaves at most 64 KiB for the complete serialized prompt under defaults |
| `maxResponseBytes` | 1 MiB | Maximum captured complete response artifact |
| `maxHistoryBytes` | 256 KiB | Local cumulative byte budget used for generation migration |
| `maxTurns` | 24 | Model turns per browser generation |
| `maxGenerations` | 16 | Generation limit for a continuing main conversation |
| `maxToolCalls` | 16 | Maximum validated tool calls in one response |
| `maxJsonDepth` | 48 | Maximum response JSON nesting |
| `wallTimeoutMs` | 60 minutes | Local invocation wall budget; an outer caller may impose less |

These are local policies, not claims about an official GPT-6 or ChatGPT token window. The token-meter hint is derived from the byte budget; the final serialized-byte guard still applies. The response limit is separate from the smaller output reserve. Raising local limits cannot prove the website will accept a larger request.

## 7. Activity, concurrency, and cancellation

Activity notifications carry bounded identities, sequence numbers, and observed changes such as prompt acceptance, content, phase, or completion. They do not include answer bodies and are not synthetic heartbeats. A browser turn can be opaque between observations, so a caller must not treat missing output as proof of a dead process.

Connection concurrency defaults to **one remote model turn**. Capacity is released before local tool or child-agent waiting so the parent does not hold the browser slot while a child needs it. Queueing and reconnects retain the remaining wall deadline; cancellation must prevent a late submission. An unresolved remote turn retains its responsibility and cannot be turned into free capacity by killing the local worker.

Local cleanup and remote generation are separate facts. Closing a CDP client or observing local process exit does not prove the website stopped generating. Cancellation attempts to stop the exact owned request and drains owned local work; a missing remote acknowledgement remains unknown.

## 8. Recover an interrupted operation

The provider card lists pending operations under **Recovery needed**. Preserve the original profile, plugin state, recovery directory, and DSH session history. They jointly identify the owned request and its durable receipts.

1. Use **Inspect captured result** to reconcile the original operation. This reads existing artifacts or observes the owned browser conversation. It may update local recovery evidence; it sends no new prompt, regenerates no answer, and executes no local tool.
2. Review the recovered response, its original session, and any requested tool effects. A known complete response still needs the corresponding host commit.
3. Use **Adopt response and its tools** only when you intend to commit that captured response. With a compatible live host, adoption verifies the original request/surface and the private artifact, then commits through the normal host transaction. A main response may execute its validated local tools under the original permissions. A summary uses its own summary transaction.
4. Adoption does **not** automatically continue with another model request. Inspect the resulting session and explicitly choose the next action.

Adoption cannot settle an unrelated uncertain tool, another pending response, a changed session surface, or missing original ownership. If those checks fail, the operation remains blocked. A process restart, fresh session, provider change, or a new browser conversation does not authorize replay of a workspace's unresolved execution domain.

| Fact | Question it answers |
|---|---|
| Dispatch | Is sending the original request confirmed, disproven, or unknown? |
| Outcome / host commit | Was a valid answer captured and durably accepted by its owner? |
| Remote generation | Is the owned remote turn still running, terminal, or unknown? |
| Local cleanup | Were owned local resources released? |
| Usage | Are authoritative counters available? |

An unknown business outcome with confirmed local cleanup is valid. Unknown usage is not zero usage. Recovery preserves the facts it can establish without inventing the others.

## 9. Flywheel and other SDK callers

Flywheel consumes this same DSH model. Configure a supported role or loop with the exact values:

```yaml
harness: dsh
provider: chatgpt
model: gpt-6-pro-web
thinking: pro
```

This is a binding fragment, not a complete Flywheel task configuration. The SDK profile used by Flywheel must actually load this candidate, the compatible host extensions, and the single compaction engine. Installing the plugin only into a separate Desktop profile does not make it available to another SDK process. A stock SDK must fail admission instead of pretending to have Web support.

The public `chatgptWebHost` service negotiates the exact binding and invocation identity. Its version 1 receipt names transport, connection, account, context policy, observation mode, and unknown usage. The `dsh-plugin-chatgpt/web-host` export advertises `webHostCapabilities` and `web-runtime/1`; importing it is a static contract check and never launches Chrome or verifies an account.

Flywheel keeps its existing budget and permission rules. A hard token budget can block later calls when actual usage is unknown. Selecting this model does not silently relax that rule, and the plugin does not estimate a token count and report it as authoritative usage or cost.

## 10. Current acceptance boundaries

| Area | Current boundary |
|---|---|
| Live account and UI | Real macOS, a signed-in ChatGPT account, and the current website layout have not passed end-to-end acceptance. Account entitlement and matching visible controls are required at runtime. |
| Browser environment | A Chromium smoke attempt in the available sandbox failed at socket setup with `EPERM`. That is an environment limitation, not evidence that live Chrome control passed. |
| Media | No image or file upload path is enabled. Original attachments are rejected before text-only projection; they are not silently omitted. An authorized local text-reading tool remains available when the role permits it. |
| Website full-context refusal | Local byte pressure and generation migration are implemented. A website refusal does not yet provide reliable proof of no side effect; ambiguous submission stays fenced instead of automatically starting a replacement chat. |
| Invalid response format | No automatic repair, resend, or retire/discard action. Whole-response validation fails before tool exposure, retains the artifact, and keeps its capacity blocked; read-only recovery does not make invalid JSON adoptable. |
| Project creation interruption | An uncertain creation can require manual identification of the owned project. Automatic reconciliation of that ambiguity is unavailable; repeated new project creation is blocked. |
| Browser history and names | Owned projects/chats are retained and naming logic is implemented. Real-account history visibility, revisiting, and current UI naming controls remain part of live acceptance. |
| Usage and throughput | Website token/cost counters stay unknown. Offline success does not measure Pro latency, capacity, quota consumption, or model quality. |

## 11. Verification and implementation references

Run the checks appropriate to the candidate and the exact patched host:

```sh
npm run typecheck
npm test
npm run build
npm run check:i18n
npm run verify:package
node scripts/verify-web-harness.mjs /absolute/path/to/patched/deepseek-harness
```

The Web harness exercise uses real DSH AgentLoop, compaction, tool execution, host acknowledgement, and local persistence with an offline browser-page fixture. Protocol, transport, session, recovery, and DOM-fixture tests cover narrower boundaries. None substitutes for the live acceptance described above. Final run results belong to the candidate's validation record; this guide does not assign a passing count to an unrun command.

- [Model and local policy](../src/web/policy.ts), [settings](../src/web/config.ts), and [native model registration](../src/index.ts).
- [Public host integration](../src/web/integration.ts) and [execution-domain ownership](../src/web/host.ts).
- [Incremental history and durable delivery](../src/web/session-coordinator.ts), [tool protocol](../src/web/protocol.ts), and [browser transport](../src/web/transport.ts).
- [DSH compatibility patch and build instructions](../compat/README.md).
