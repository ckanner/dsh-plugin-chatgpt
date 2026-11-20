# Experimental Web bridge: protocol and durability

English | [中文](web-bridge-contract.zh.md)

This documents the protocol/durability foundation of the [stock-DSH sidecar design](design/chatgpt-web-sidecar.md). The installed provider keeps SIWC for its existing models and adds an opt-in Web route through the [managed browser setup](web-provider.md). Programmatic users may still supply a `WebPageTransport` explicitly. Offline contract tests never contact ChatGPT or use an account; real signed-in acceptance is a separate requirement.

## Implemented boundary

The experimental package entry is `dsh-plugin-chatgpt/experimental/web-bridge`. It exports the engine, HTTP server, thin client, public contracts and request normalization helpers. Importing it does not start a process, launch Chrome, register a model or change a DSH profile.

| Component | Responsibility |
| --- | --- |
| `request.ts` | Synchronously detach raw public `GenerateOptions`, including durable message IDs and `toolHistory`, before asynchronous work. |
| `protocol.ts` | Bound JSON, canonicalize semantic identity, validate namespaces/receipts and complete schema-checked responses. |
| `journal.ts` | Owner-only durable snapshots, file and parent-directory fsync, physical-profile exclusion and permanent journal binding. |
| `engine.ts` | Serialize page operations, retain request tombstones, fence uncertain submissions and claim executable delivery once. |
| `server.ts` | Loopback authentication, private client leases, finite SSE and inspection/reconciliation controls. |
| `client.ts` | Validate the authenticated binding and entire SSE response, then emit public DSH chunks and close the iterator. |

The model contract accepts only `gpt-6-pro-web` with `pro` effort. This is a protocol identity, not an availability claim. The complete existing SIWC model catalog and dispatch path remain in the normal provider entry.

## Request and response rules

The hash covers the installation, provider route, physical-profile binding, account binding, session, purpose, message identities, ordered body, effective system instructions, current and historical tool definitions, controls, attachment versions and parent receipt. Transport lease/attempt IDs are excluded. The server recomputes the hash before looking up a request. A supplied parent receipt must agree with the hashed assistant history and local journal evidence.

Normal calls require a session ID and stable IDs on every supplied message. Compaction allows its final identity-free user instruction after identified source messages. Session titles use their semantic input rather than the producer's fresh wrapper UUID. Foreign SIWC replay state is not forwarded. A fork cannot adopt the source session's Web receipt.

An exact receipt-bound append may continue the current generation only while its parent is still that generation's latest admitted turn. Changed prefixes, instructions, tool history or branches from an older parent start a new generation. The transport still prepares and verifies its page before each submission; the journal's generation ID does not prove that a live page is aligned.

The injected page returns exactly this complete envelope:

```json
{
  "version": 1,
  "complete": true,
  "blocks": [
    { "type": "text", "text": "A complete answer." }
  ]
}
```

Tool blocks have `type: "tool-call"`, a response-local `id`, an admitted `name`, and JSON-string `arguments`. The bridge validates JSON Schema draft-07 arguments using Ajv without coercion/default insertion, rejects unsupported schemas and external references before submission, rejects duplicate IDs, and namespaces each call ID to its response. Auxiliary purposes cannot emit tool calls. Complete blocks and their digest are persisted before successful delivery.

The finite SSE response has one `response` event containing the full `WebResponse`, followed by a matching `finish` event and EOF. The client buffers and validates all three boundaries before exposing DSH chunks. It emits no invented reasoning or token usage. A tool response closes with `finish.reason.kind = "tool-calls"`; the real stock host then executes its tools and sends results in the next provider request.

## Durability and ownership

Explicit first setup supplies `directory`, `profileDirectory`, a verified `WebBinding`, and `initialize: true` to `openWebBridge`. Later starts reuse that exact binding and evidence. The implementation creates a persistent marker in the physical profile naming its journal. Switching the journal path, account or installation cannot silently hide earlier uncertainty. Missing/corrupt evidence fails closed, even if setup is requested again.

The state sequence is `accepted → preparing → submit_intent → submitted → observing → completed`. The `submit_intent` snapshot is atomically replaced and fsynced before `transport.submit()` can run. Failure or cancellation after that boundary conservatively becomes `uncertain`; the entire physical profile rejects new submissions until read-only reconciliation proves a terminal outcome. A pre-Send interrupted request keeps a terminal tombstone instead of restarting automatically.

Two callers of the same exact key join one page operation. Completed text can be replayed. A tool-bearing response first commits a durable `delivery-intent` for one `clientLeaseId + deliveryAttemptId`. Every later request for that cached tool response fails with `WEB_DELIVERY_CLAIMED`, including a reconnect using the same owner. Losing the stream does not transfer ownership. Continuation requires the exact receipt/content and one matching result per call; missing, duplicate or conflicting results do not authorize another tool invocation.

`recover` only reads page evidence and reconciles the journal. `discard` retains a tombstone and does not clear an unknown browser outcome. Inspection data is not permission to execute its tool blocks. A receipt proves what this bridge recorded; it is not a host persistence ACK or proof of tool execution.

The browser transport can establish `terminal-failure` for a fully observed but protocol-invalid response after saving immutable, bounded response/transcript evidence and rechecking the same account, Project and identities during explicit recovery. It does not advance the successful generation prefix. Changed evidence, incomplete output, generic alerts or failed durable writes remain unknown; known prompt and conversation identities cannot be replaced by same-text candidates.

Locks use exclusive directories under the real physical profile and journal. They contain a random owner token and are never reclaimed from a stale PID alone. Clean shutdown waits for all transport operations to settle before releasing those locks. After a hard process crash, an operator must first establish that no bridge/owned browser operation remains and inspect the evidence before manually resolving stale locks. There is deliberately no automatic lock-stealing command. The durability implementation is verified on POSIX; Windows directory-fsync behavior is not claimed by this phase.

The snapshot journal has a 64 MiB bound and no automatic deletion/compaction. Reaching that bound stops admission. This bounded foundation preserves evidence; a production retention/archival policy is separate work.

## HTTP and client lifecycle

`startWebBridgeServer({ engine })` binds an ephemeral `127.0.0.1` port and generates a private launch bearer token. Every endpoint requires it. Host must match the literal listener authority; browser Origin headers, ambiguous credentials, redirects, encoded bodies and non-JSON POST bodies are refused. Model request bodies allow 32 MiB including exact inline images; all other bodies and responses retain the 1 MiB limit. Nesting is bounded to 64 levels, headers to 16 KiB and request-body reading to 10 seconds. The model operation itself is not given that 10-second deadline.

`WebBridgeClient({ url, token, expectedBinding, errorFactory })` checks the handshake and registers its own private lease. Its `stream(options)` captures the caller input immediately, before iterator advancement or connection setup. Heartbeats renew only that lease. `dispose()` releases its lease and cancels its owned work; another client's server/work remains alive. The host adapter supplies an `errorFactory` creating its public `LlmError`. The real-host fixture demonstrates that public integration without a DSH patch.

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Authenticated instance/binding handshake identifying the `experimental` or `browser` transport. |
| `POST /v1/clients` | Register a private lease with `{}`; default TTL is 60 seconds. |
| `POST /v1/clients/:id/heartbeat` | Renew only that lease using `{}`. |
| `DELETE /v1/clients/:id` | Release only that lease. |
| `POST /v1/turns` | Admit the exact normalized request and deliver one finite response. |
| `GET /v1/turns/:id?sessionId=...` | Inspect a request joined by this lease. |
| `POST /v1/turns/:id/cancel` | Cancel only the initial submitting client's work. |
| `POST /v1/turns/:id/recover` | Reconcile read-only page evidence. |
| `POST /v1/turns/:id/discard` | Retain an explicit discard tombstone. |

Lease-scoped requests carry `X-Web-Client-Lease`. Turn controls use `{ "sessionId": "..." }` for POST. A new lease cannot gain control by supplying a session ID alone: it must first re-admit the identical hashed request. Joining records its participation even if the reply is `WEB_UNCERTAIN` or `WEB_DELIVERY_CLAIMED`; it does not resend the page prompt or grant executable replay. Turn IDs are deterministic: `turn-` followed by the request SHA-256 hex digest. Only the original admitting client may cancel the underlying operation.

The page-transport seam is deliberately narrow: `prepare` is read-only, `submit` is the sole remote mutation boundary, `observe` supplies the complete envelope, and optional `recover` supplies read-only terminal evidence. Chrome records separate durable intent/evidence for each Project, model-selection, upload, input and Send mutation. The optional `discard` hook only records local abandonment; it does not mutate the website or clear an uncertain model outcome.

## Browser integration and remaining acceptance

The follow-on browser/provider implementation adds Chrome discovery/launch, visible account and GPT-6/Pro verification, Project isolation, DOM extraction, setup/recovery UI and an independently owned daemon. Its setup guide records the exact limits. A caller-provided `accountBinding` in an offline fixture remains no proof of a live account, and a Chromium fixture remains no proof of the signed-in website layout.

Exact host-owned image versions are now transferred and stored by digest, with journal references verified on reopen. Files remain unsupported. `temperature`, `maxTokens` and `stop` are rejected rather than silently ignored. Web v1 accepts only normal turns: `compaction` and `session-title` fail with `WEB_AUXILIARY_UNSUPPORTED`, so DSH must route those purposes to a separate provider or disable the optional title plugin. The installed provider requires a local context budget but does not inspect Loader fibers or private compaction configuration. No Web usage estimate, enforceable hard budget or Flywheel task-completion claim is provided here. Flywheel has its own consumer integration and acceptance requirements.

## Reproduce validation

```sh
npm ci --ignore-scripts
npm run test:web
npm run typecheck
npm run build
```

The stock host gate uses the released DSH `dsh-v0.2.2-rc.5` commit `9c2670d3bce5275e0d1610272958121af87787bb`. In that unmodified checkout, run `node native/system/scripts/build.ts --host-addon-only` with the matching Node headers installed. Supply its normal dependencies, or isolated pinned dependencies as shown in `.github/workflows/web-contract.yml`, then run:

```sh
npm run verify:web-agent-loop -- /path/to/deepseek-harness --deps /path/to/isolated-host-dependencies
npm run verify:web-plugin-host -- /path/to/deepseek-harness --deps /path/to/isolated-host-dependencies
```

The script bundles the real stock AgentLoop, LLM runtime, BlockAssembler, native tool executor, JSONL persistence and checkpoint policy. It checks the selected commit and unchanged tracked host files before and after execution; the page transport alone is a fixture. CI and release share this Linux gate on Node 24, while ordinary bridge tests run under both supported Node 22 and 24 lines.

| Real-host scenario | Tool executions | Page submissions | Host attempts |
| --- | ---: | ---: | ---: |
| Normal tool loop | 1 | 2 | 2 |
| Completed text lost before host delivery, then retried | 1 | 2 | 3 |
| Tool blocks exposed but finish lost, then retried | 0 | 1 | 2 |
| Two clients concurrently join one tool response | 1 | 2 | 2 |

These checks establish the stock host boundary, including assistant checkpoint before tool execution and receipt/results in the next request. They do not establish live ChatGPT availability or page behavior.
