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
   reasoning. Output indexes now identify independent durable blocks. Successful
   item-done events supply native replay data; terminal output can backfill
   encryption. SIWC can finish with `output: []`, which must not erase the
   complete items already received.
3. DSH stores that data through the standard `finish.replayState` envelope.
   Each visible block has a fingerprint. Changed content, removed blocks, unknown
   envelope versions, different accounts/endpoints/providers/models, and foreign
   adapters fall back to visible history. Partial/failed responses do not claim
   reusable native state. Empty reasoning summaries still retain their opaque item.
4. System/developer messages retain their instruction role. The resolved model
   advertises `systemPromptUpdate: "in-history"`, allowing DSH to append updates
   at their original positions. Tools remain in host-provided order.
5. A stable 64-character hash scopes `prompt_cache_key` and the `session_id`
   header to the account registration, endpoint, provider, session, and purpose.
   Tokens and email addresses are never part of the key. Renewing an access token
   preserves the identity. Sessionless calls omit both fields.
6. Default context is the account's ordinary window, limited to 272,000 tokens.
   `contextWindowLimit` can lower the budget or explicitly enable an extended
   window, bounded by account metadata. It is read when a model is resolved.
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

The host must support DSH's `ReplayEnvelope` on the terminal finish chunk and
`systemPromptUpdate` in resolved model metadata. No DSH core change or session
format migration is required. Old sessions remain readable but cannot recover
encrypted reasoning that an earlier adapter discarded.

Corrected roles/order and the new cache identity change the initial wire prefix.
Expect a cold request after upgrading. Model/effort switches, context compaction,
tool changes, account changes, and normal cache expiry can still reduce reuse.
The context budget does not impose a spending cap; SIWC rejects
`max_output_tokens`. It can cause existing large sessions to compact earlier.

## Verification

`npm test` includes:

- Exact previous-input prefix assertions after further tool calls and commentary.
- Multiple text/reasoning items, empty summaries, interleaved indexed deltas,
  authoritative final arguments, refusal output, and terminal-only snapshots.
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

These checks establish serialization and persistence correctness. They do not
measure the service's live cache hit rate or ChatGPT allowance deduction.

A bounded live smoke check on 2026-10-12 used GPT-6.1 Sol with medium effort and
three short synthetic requests (including a function call and a developer update).
All three completed and saved native replay state. The two continuation requests
preserved the complete preceding input and reported 2,816 / 3,062 (91.97%) and
2,944 / 3,096 (95.09%) cached input tokens. The cold first request reported none.
This sample produced zero reasoning tokens, so encrypted reasoning is covered by
offline/real-assembler fixtures, not demonstrated by that live sample. The check
does not establish a sustained hit rate, a controlled comparison with Pi or the old
adapter, or an exact reduction in ChatGPT plan usage.

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
