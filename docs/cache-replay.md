# SIWC history and cache repair

This provider stays inside DSH: the host owns the agent loop, durable messages,
tools, compaction, and usage projections. The plugin owns OAuth, account model
discovery, Responses serialization, and its opaque replay envelope.

## Problems and changes

1. The old converter split messages and tool traffic, then appended all tools
   after all prose. Appending commentary therefore inserted content before
   previously sent tool results. One ordered message/block traversal now emits
   developer instructions, assistant text, calls, and results in place.
2. Stream parsing discarded output-item boundaries, IDs, phases, and encrypted
   reasoning. Native item IDs identify blocks; output indexes determine order
   when supplied. Missing indexes never become zero. Indexed gaps are buffered
   so an earlier item can still precede them in DSH's first-seen block order.
   Item-done events supply native replay data. Partial/reordered terminal arrays
   backfill metadata by ID; positions are used for new display items only after
   agreement with all observed positions and content. Unmatched/conflicting
   snapshots cannot overwrite a different block or throw away a completed turn.
   SIWC's `output: []` never erases previously received complete items.
   Structurally complete done-only messages lacking both index and ID retain
   their text in arrival order; no identity is invented. Malformed message items
   missing `role: "assistant"` or a supported `content` array are ignored, while
   any text already received through deltas remains visible. Tests cover both
   paths through the decoder and real DSH assembler.
3. DSH stores that data through the standard `finish.replayState` envelope.
   Each visible block has a fingerprint. Changed content, removed blocks, unknown
   envelope versions, different accounts/endpoints/providers/models, and foreign
   adapters fall back to visible history. Partial/failed responses do not claim
   reusable native state. Missing reasoning summaries are accepted, with
   `content` or streamed previews used for display. Requests supply the required
   empty summary array when absent. Unavailable ciphertext or reasoning IDs
   disable the entire native replay, including linked native call item IDs.
4. System/developer messages retain their instruction role. The resolved model
   advertises `systemPromptUpdate: "in-history"`, allowing DSH to append updates
   at their original positions. Tools remain in host-provided order.
5. A stable 64-character hash scopes `prompt_cache_key` and the `session_id`
   header to a local authorization namespace, client registration, endpoint,
   provider, session, and purpose. The manager creates a fresh random namespace
   on adoption, even if a caller supplies the same client ID, subject, or email.
   Refresh and restart preserve it; reauthorization replaces it. Tokens, email
   addresses, and synthetic account labels are never used as replay identities.
   Sessionless calls omit cache identifiers. Missing/invalid namespaces disable
   both native replay and these identifiers until the credential is managed.
6. Default context follows each model's account-catalog window, without a shared
   fixed cap. An exact `modelContextWindowLimits` entry takes precedence over
   the global `contextWindowLimit`; explicit values are used as-is, following
   Pi's override behavior. Both are read when a model is resolved.
   Default output reservation fits within half the selected budget. DSH still
   decides when and how to compact; the adapter does not delete history.

## Why borrow Pi's approach

Pi 1.1.0's `openai` provider implements the public SIWC flow. Its separate
`openai-codex` provider is legacy and uses a different backend. This repair
follows the public path's ordered history, native reasoning replay, developer
roles, session identity, and omission of unsupported cache-retention controls.
It does not introduce another agent loop or replace DSH's persistence with Pi's.

- [Pi public SIWC provider](https://github.com/earendil-works/pi/blob/v1.1.0/packages/ai/src/providers/openai.ts)
- [Pi Responses conversion and replay](https://github.com/earendil-works/pi/blob/v1.1.0/packages/ai/src/api/openai-responses-shared.ts)
- [Pi request construction](https://github.com/earendil-works/pi/blob/v1.1.0/packages/ai/src/api/openai-responses.ts)
- [Official SIWC endpoint and model discovery](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [SIWC route limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Stateless reasoning replay](https://developers.openai.com/api/docs/guides/reasoning#preserve-reasoning-without-stored-responses)

## Compatibility and migration

The interactive token exchange already rejects missing ID tokens and absent or
empty `sub` claims. Optional subjects exist at the credential/storage seam; a
programmatic adoption previously promoted its fallback map key into that field.
The account-scope hash also included `clientId`, so a collision required the same
issued client ID. Version 0.1.11 removes reliance on either subject provenance or
positional map keys: grants get independent replay namespaces. This is local
authorization isolation, not an assertion of cryptographic OIDC identity validation.

Legacy credential records acquire and persist a namespace on first load, without
changing tokens or account selection. The auth-file version remains 1 with an
additive field. Old replay scopes no longer match. Unknown subjects stay unknown;
their local UI account keys are random and are not written back into `subject`.

The host must support DSH's `ReplayEnvelope` on the terminal finish chunk and
`systemPromptUpdate` in resolved model metadata. No DSH core change or session
format migration is required. Old sessions remain readable but cannot recover
encrypted reasoning that an earlier adapter discarded.

Corrected roles/order and the new cache identity change the initial wire prefix.
Expect a cold request after upgrading. Model/effort switches, context compaction,
tool changes, account changes, and normal cache expiry can still reduce reuse.
The context budget does not impose a spending cap; SIWC rejects
`max_output_tokens`. It follows the account catalog, so a model whose advertised
window grows keeps more history before DSH compacts, and an explicit
`contextWindowLimit` below that default compacts sooner.

Without an override, the context budget is the model's `contextWindow`.
No fixed 272K, 500K, or 1M cap replaces the account default.
A catalog refresh after the 60-second listing cache expires
updates that default on the next model resolution. Missing account capacity
metadata falls back to the bundled catalog or conservative unknown-model default;
an unlisted measured model keeps that default. Observed route maximums remain
descriptive metadata and do not impose a separate budget ceiling.

The global `contextWindowLimit` and every `modelContextWindowLimits` value must
be safe integers of at least 1,024 tokens. Model entries match exact,
case-sensitive IDs; display names, prefixes, and wildcard patterns do not match.
The precedence is `modelContextWindowLimits[model.id] ?? contextWindowLimit ?? model.contextWindow`.
An explicit value is never clamped to the catalog default or maximum. For a model with a
500,000 default and 872,000 maximum, `contextWindowLimit: 1000000` selects
1,000,000. The same override works when maximum metadata is missing or the model
is unlisted. Catalog refreshes do not shrink an explicit budget. Clearing the
model entry restores the current global budget, or the latest account default
if no global budget exists. Clearing all overrides restores each model's latest
default. Both configuration fields are live DSH settings and are read on each
model resolution. An invalid selected model value reports its configuration key
instead of silently falling back. The global override applies to this provider's
models, independently of Codex configuration; DSH still computes its own
compaction threshold and output headroom.

The model's published total context window, catalog metadata, and effective
client budget are separate values. The official model pages list
a 1,050,000-token total window and 128,000 maximum output tokens for
[GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) and
[GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra).
This plugin follows [Pi 1.1.0's explicit override precedence](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/provider-composer.ts),
while using the account catalog for defaults. Pi's own defaults instead come
from its bundled catalog and pi.dev updates. Codex uses a different
[override rule](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/models-manager/src/model_info.rs)
that clamps to `max_context_window`; this plugin does not apply that clamp.
Changing a client budget does not change the service's actual request limits.
An observed 872,000 catalog value is not evidence that a larger HTTP request
was tried and rejected, and a one-million client budget is not a live inference
capacity test.

Tests cover different defaults in one account, catalog updates, explicit one-million
budgets above catalog maxima, missing metadata, smaller budgets, invalid values,
clearing overrides after catalog changes, per-model/global/default precedence,
exact-ID matching, and independent budgets for models missing from the catalog.

## Verification

On a clean checkout, install development dependencies with `npm ci --ignore-scripts`.
Run `npm run build` before `npm run verify:package`; packaging validation reads
the generated `lib/` artifacts. Typechecking requires the installed `@types/node`.
The same strict configuration now includes every test and fixture; it does not
disable strict null checks, unchecked-index checks, or exact optional properties.

`npm test` includes:

- Exact previous-input prefix assertions after further tool calls and commentary.
- Multiple text/reasoning items, empty summaries, interleaved indexed deltas,
  authoritative final arguments, refusal output, and terminal-only snapshots.
- Missing output indexes, late earlier items, partial/reordered/conflicting
  terminal arrays, missing reasoning summaries, and parallel calls correlated by ID.
- Native item/ID/phase/argument preservation through JSON session restore.
- Edited/pruned/cross-account/cross-model/malformed replay fallback.
- A local HTTP/SSE round trip through the adapter with captured request bodies
  and headers; it checks native replay after a fresh adapter instance.
- Account/session/purpose isolation and context budget validation.
- Unchanged provider usage accounting and existing authentication/error tests.

Run `npm run verify:harness -- /path/to/deepseek-harness` against a DSH checkout.
It bundles that checkout's real BlockAssembler and verifies assembly, empty
encrypted reasoning, JSON restore, the plugin request boundary, and DSH's
max-token block-pruning behavior. It neither boots a profile nor calls a model.
Both CI and release checks run it against public DSH commit
`d743267388641bc76f17c45ce8b4c231aed1d32c`, with the same malformed-stream
fixtures as the unit tests. This is a checked contract for that pinned host,
not a claim about every future DSH version. Run it against a candidate checkout
when updating the host. Block-count guards deliberately invalidate pruned
whole-response snapshots; separate same-length mutations test fingerprints
without relying on those count guards.

The legacy `include: ["reasoning.encrypted_content"]` hint is sent only when an
explicit reasoning effort is selected, matching Pi's request path. This is
request compatibility discipline, not evidence that unconditional inclusion
caused the measured cache misses.

These checks establish serialization and persistence correctness. They do not
measure the service's live cache hit rate or ChatGPT allowance deduction.

A bounded live smoke check on 2026-10-12 used the initial repair working tree,
before the authorization and stream-reconciliation fixes in `3016090` and
`272cbce`. The probe did not record an exact Git revision, so these historical
numbers must not be attributed to the current revision. It used GPT-6.1 Sol
with medium effort and three short synthetic requests (including a function
call and a developer update).
All three completed and saved native replay state. The two continuation requests
preserved the complete preceding input and reported 2,816 / 3,062 (91.97%) and
2,944 / 3,096 (95.09%) cached input tokens. The cold first request reported none.
This sample produced zero reasoning tokens, so encrypted reasoning is covered by
offline/real-assembler fixtures, not demonstrated by that live sample. The check
does not establish a sustained hit rate, a controlled comparison with Pi or the old
adapter, or an exact reduction in ChatGPT plan usage.

A separate live fallback check on 2026-10-12 used GPT-6 Astra / high. A short
arithmetic prompt produced 207 reasoning tokens, one encrypted reasoning item,
and one function call. Replaying the native reasoning and call completed
successfully. Removing replay metadata then sending the same visible call and
tool result also completed: the fallback kept `call_id` but omitted the native
call item `id` and the reasoning item. This validates endpoint acceptance for
that concrete fallback, not equivalent answer quality for arbitrary histories.

For a bounded live comparison, use the same public SIWC endpoint, account,
model, effort, stable tools, synthetic prompt, and request spacing for each
variant. Compare the old adapter, repaired adapter, and Pi's `openai` provider;
do not mix in Pi's legacy Codex provider. Separate the cold first request from
later tool turns. Record per-request input tokens, cached tokens, cache writes
when reported, output/reasoning tokens, latency, and ChatGPT usage changes.
Use an explicit request/token budget and stop on a quota or authentication error.
Never publish credentials, authorization URLs, encrypted reasoning, or user prompts.

Compute the aggregate read ratio as total cached tokens divided by total input,
not the average of per-request percentages. Verify request prefix identity
independently of the hit rate. No particular cache ratio is promised.
