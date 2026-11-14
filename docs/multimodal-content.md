# Durable image and tool-output contract

The adapter sends images from user attachments and tool results, including a
PTC program's projected LCU screenshot, through the same Responses request.
It does not evaluate PTC programs or infer an image from a printed handle. PTC
and LCU must actually supply a DSH `image` content block alongside their text.

## Request path

1. `requestOf` preserves the durable image reference and its `offloaded` marker.
2. `ChatGptAdapter.stream` validates roles and the model's existing account/catalog
   `inputModalities`, then resolves the optional `attachments` host service.
3. `readImage(ref, signal)` returns `{ ref, data }`. The store owns decoding and
   digest validation; this adapter additionally checks reference identity,
   media type, encoded length and dimensions against the request. It never
   interprets an attachment ID as a filesystem path or URL.
4. The image becomes a base64 data URL only in the request-local copy. Repeated
   identical references are read once per request; conflicting metadata under
   one ID fails. Durable history is not mutated and does not gain base64 bytes.
5. User images become `input_image` message content. Image-bearing tool results
   use `function_call_output.output` as an ordered `input_text`/`input_image`
   array, retaining the original `call_id`. Text-only tool results remain
   strings; JSON text is not parsed or reformatted. An error result keeps an
   explicit `Error: ` text marker as well as its images.

The official Responses [create schema](https://developers.openai.com/api/reference/resources/responses/methods/create)
allows function outputs as text or content arrays. This describes wire support,
not a live assertion about a particular SIWC account/model. Model entitlement,
account state and upstream endpoint behavior remain authoritative at call time.

The DSH attachment contract was checked in both
[rc.3 release types](https://github.com/deepseek-ai/deepseek-harness/blob/38a6a5c965aa99ab525161efb7cc5cf1fe62fced/packages/attachment/attachment/src/types.ts)
and [later master types](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/attachment/attachment/src/types.ts).
Both expose `StoredImageAttachment { ref, data }`; the plugin uses only the
stable structural `readImage` contract and adds no mandatory attachment peer.
Text-only requests still work when the service is absent.

## Explicit limits and failures

| Condition | Behavior |
|---|---|
| Host `offloaded: true` image occurrence | Keep a deterministic text notice; do not reread or resend its bytes |
| Non-image model, absent service, invalid reference, unsupported role | `UNSUPPORTED_CONTENT`, before inference |
| Missing storage object, mismatched reference or byte length | `chatgpt_attachment_read_failed`, before inference |
| File block reaching the adapter | `UNSUPPORTED_CONTENT`; this adapter does not upload raw files |
| Tool result missing its originating call ID | Explicit failure; no dropped output |
| Cancellation before/during attachment preparation | `ABORTED`; late reads cannot dispatch a request |
| Cancellation or early consumer return during streaming | Close the response reader; no synthetic success or estimated usage |
| Incomplete response due to `max_output_tokens` | Host `max-tokens` finish |
| Other/unknown incomplete reason | `response_incomplete` error, with the observed reason |

DSH can project files into readable file-handle text before reaching the adapter;
that ordinary text continues to work. Raw file upload and images in assistant or
instruction roles are outside this adapter's contract. Image resizing and Files
API upload are not added here: stored normalized images are sent inline, and an
upstream size/format refusal remains a visible provider error.

Cancellation retains block closure and any usage the provider already reported.
Absent counters stay absent. If no terminal usage arrives, callers must keep
usage unknown rather than infer zero from the cancellation.

## Static capability and verification

```js
import { contentCapabilities } from 'dsh-plugin-chatgpt/capabilities'
// { version: 1, imageInputRoles: ['user', 'tool'],
//   imageSource: 'durable-attachment-service',
//   toolOutput: 'text-or-responses-content-array', fileInput: false }
```

This import performs no credential access and mounts no host service. It declares
implemented conversion behavior; it is not a live probe receipt, model allowlist
or proof that a screenshot reached a model. Runtime qualification should bind
the exact package candidate, host attachment service and selected account/model,
then send a known image through the actual route and check its response.

`tests/images.spec.ts` exercises `requestOf` → attachment preparation → neutral
conversion → the production HTTP client using an in-process endpoint and known
PNG bytes. It covers both image paths, error/JSON/ordering preservation,
offload/replay, missing/corrupt inputs, model gating, cancellation at attachment
and stream boundaries, actual reported usage and early reader disposal.
The existing replay suite and `verify:harness` additionally check serialization
against the actual DSH BlockAssembler. These are local contract checks; they do
not run the user's desktop or spend a real subscription allowance.
