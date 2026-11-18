# DSH host compatibility contract

English | [中文](README.zh.md)

This directory contains a source compatibility candidate for DeepSeek Harness. The Web provider requires these public host extensions; installing this ChatGPT plugin into an unmodified DSH desktop or SDK does not add them. The plugin checks runtime capability markers and refuses Web calls when they are missing. The existing Sign in with ChatGPT transport remains independent of this opt-in Web capability.

## Exact source and installation boundary

The patch targets `deepseek-ai/deepseek-harness` commit `ca33fd6843b205e279c7ccb6cb73a472c78f5760`, whose package version is `0.2.2-rc.4`. It does not change DSH's release version and is not a published DSH release. [manifest.json](manifest.json) records the exact base, SHA-256, resulting source tree, capabilities, and verification limits. Keep the patch and manifest together.

Use a clean checkout at that exact commit, Node.js 24.9 or newer, and the upstream `pnpm@11.28.5` toolchain. The packaged verifier checks the patch hash, base commit and complete resulting tree before applying it to a clean checkout:

```sh
node /absolute/path/to/compat/verify.mjs /absolute/path/to/dsh --apply
cd /absolute/path/to/dsh
pnpm install --frozen-lockfile
pnpm run build
```

Run the same verifier without `--apply` to check an already patched checkout. Verification uses a temporary Git index and preserves staged changes. It rejects a different base, modified patch bytes, missing patch files and unrelated source changes. The verifier ships with the npm archive; it does not install dependencies, publish packages or alter an existing DSH application.

Follow the patched checkout's development instructions to run its SDK or build its desktop application. An already installed desktop continues to use its own bundled host until it is replaced with a build containing these changes. Applying a patch to a separate checkout does not change that desktop. Do not force this patch onto another base; review and regenerate it if upstream has moved.

The patch includes source, focused tests, bilingual API references, generated catalogs, dependency references, and the required compatibility record for optional session event fields. Existing session log versions remain unchanged. Older readers can ignore these optional fields, but cannot provide recovery approval or the new host APIs.

### Upgrade an earlier compatibility candidate

An earlier candidate advertises `summaryRoute: 1`; this plugin requires `summaryRoute: 2`. Start from a clean checkout of the exact base above, apply the current patch, and rebuild the DSH host together with the updated plugin. Do not layer the current patch over the earlier patch. The DSH package version stays `0.2.2-rc.4`, so use the manifest and runtime capability markers to identify this candidate. This follow-up changes route metadata and maintenance ownership without changing session formats.

## Public runtime contract

| Owner | Capability markers | Public behavior |
| --- | --- | --- |
| `ctx.agentLoop.hostPolicyCapabilities` | `replayVeto: 1`, `durableResponseAck: 1`, `recoveredResponse: 1` | Hard retry veto, awaited durable assistant commit, explicit captured-response adoption |
| `ctx.compaction.hostPolicyCapabilities` | `summaryRoute: 2`, `pressurePolicy: 1`, `durableSummaryAck: 1`, `recoveredSummary: 1` | Explicit configured and proposed summary routes, validated route budgets, separate durable checkpoint acknowledgement, explicit summary adoption |

`agent/replay-check` runs before retry recovery and again before redispatch. Every matching listener settles; an `always` retry setting cannot override rejection. Plugins must scope the veto to their own requests. Without listeners, existing provider retry behavior is unchanged.

`agent/response-committed` runs after the model iterator closes, the assistant event is appended, and session flush completes, before tool execution. `compaction/committed` runs after the summary, replacement, and successful closing record commit and flush. Their `durable` flag must be true before an external provider acknowledges delivery. Neither callback may wait for the same Agent to become idle.

`compaction/summary-route` version 2 supplies `configuredTarget` only for an explicitly configured summary provider/model, separately from the proposed main destination and inherited `defaultTarget`. This lets the plugin preserve a chosen auxiliary model when the main model is Web, while selecting Web Pro after a main-model switch when no summary override exists. Version 1 cannot distinguish those cases and is rejected before Web dispatch. `compaction/pressure-policy` merges explicit route overrides through the existing strict budget validator. `llm.stream(options, observeResolved?)` exposes the actual bound adapter route and resolved controls to the summarizer after ordinary middleware, so recorded effort and output limits match the dispatched call. Unhandled routes retain the upstream default policy.

`ctx.agentLoop.adoptRecoveredResponse(agent, input)` and `ctx.compaction.adoptRecoveredSummary(agent, input, signal)` require their separate recovery policy events, a current Agent maintenance reservation, successful flush, and a readable `sessionPersistence` backend. They verify the original surface and request, complete artifact digest, and durable prior commit identity. Main-response adoption uses the ordinary tool pipeline only after a durable assistant commit. Summary adoption uses the normal balanced-range, shrink, and replacement transaction; it never creates an assistant message. An already committed result is returned without repeating tools or replacing history again. Reported failure may follow a durable partial commit; preserve the journal and reconcile it rather than resubmitting automatically.

`agent.runMaintenance(task)` establishes the owning Agent's initiator scope after obtaining the idle reservation, including across awaits. Manual summary calls and recovery therefore retain the original Agent, request, and workspace execution domain. The caller's scope remains unchanged outside the task after success, failure, or cancellation.

## Verification and limits

The reusable `web-host.yml` workflow is required by both CI and release. Its Linux/macOS jobs apply the verified patch, compile the affected host projects and actual native session lease, exercise retry/commit/recovery tests, and run the real cross-layer verifier. They also run the production CDP adapter against an isolated Chrome fixture; a missing or failed browser fails this job instead of silently skipping it. These checks do not sign into ChatGPT or certify a complete Desktop build. Workflow results must be checked for the exact candidate commit.

The affected source projects, focused test TypeScript check, changed-file lint, exported API documentation, type-equivalence references, and generated Cordis catalog checks passed. The earlier focused pass covered nineteen files and 512 tests. The final summary identity correction passed all 18 summary-policy tests, including eight new rejection cases, and the six real cross-layer scenarios were rerun successfully. Recovery cases use the real JSONL backend and its native write lease; a no-op flush callback alone cannot satisfy recovery admission. The host patch applies cleanly to the exact base in an isolated Git index.

The summary-route version 2 follow-up reproduced missing explicit-target metadata and incorrect maintenance ownership before the fixes. The corrected host passed the eleven-file compaction, response-policy, recovery, and Agent lifecycle selection: 300 tests with no skips, including 19 summary-policy tests and three maintenance scope settlement cases. Source/test TypeScript, changed-file lint, exported API documentation, bilingual pairing, generated catalog, and type-equivalence checks passed. All fifteen updated cross-layer scenarios passed, including interrupted manual-summary adoption and fencing a fresh Agent in the same actual workspace. This is focused verification of the compatibility source, not a complete upstream or Desktop build.

From this plugin's development checkout, run the cross-layer verifier against the patched DSH checkout. An optional second checkout connects the actual Flywheel Web policy consumer:

```sh
node scripts/verify-web-harness.mjs /path/to/patched/deepseek-harness /path/to/flywheel
```

The verifier uses real DSH AgentLoop, BasicCompaction, JSONL persistence, this plugin's transport and journals, and public hooks. Only the browser page is scripted. It covers default plugin composition, tool execution after durable acknowledgement, explicit recovery, automatic and manual compaction, and hard retry veto. The optional Flywheel path verifies its real admission and terminal receipt module. Build the upstream native system addon for the current host before running it.

This runner could not finish the complete upstream build: the `tsx` CLI's IPC socket was denied, and the full host aggregate TypeScript process exceeded available memory when retried directly. Direct execution with `node --import tsx` and the affected source/test checks succeeded. For the JSONL tests, the runner compiled the unchanged upstream flock C source with stable N-API 8 and integrity-verified official `node-api-headers@1.9.0`, because the runner's Node installation lacked development headers. No addon binary or replacement lock implementation is included in this patch. Live account, browser, and macOS desktop acceptance remain separate deployment checks.
