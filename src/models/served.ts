/**
 * Models measured to be servable through ChatGPT plan usage.
 *
 * The account's own listing is the first source for a roster, but it is not a
 * complete one: it advertises five of the models this route serves and omits
 * several others that answer normally when asked for by id. Measured on a live
 * Plus subscription, asking for `gpt-6-sol`, `gpt-6-luna`, or `gpt-6.1-sol` was
 * answered under the requested id with `response.completed`, while the listing
 * mentioned none of them.
 *
 * The bundled catalog is not a roster source either. It carries forty-four
 * OpenAI model ids drawn from the API-key surface, and thirty-six of them are
 * refused on this route — every `gpt-4*`, every `o1`/`o3`/`o4`, the coding and
 * realtime variants, and `gpt-5` through `gpt-5.4`. Offering them would populate
 * the selector with models that cannot answer.
 *
 * So this is the intersection that matters: the newest families, which are what
 * this route is for. It is measurement, not inference, and the date it was
 * measured is recorded so a reader knows how old the evidence is.
 *
 * @module dsh-plugin-chatgpt/models/served
 */

/**
 * The day these ids were measured against a live subscription. Re-measure with
 * `scripts/probe-served-models.mjs` when the roster looks stale.
 */
export const SERVED_MEASURED_ON = '2026-10-04'

/**
 * Models this route served on the measurement date, in family order.
 *
 * Every id here was verified to complete a turn. The listing advertises most of
 * them; the ones it omits are marked, because that omission is the finding that
 * made this list necessary.
 */
export const SERVED_MODELS: readonly ServedModel[] = [
  { id: 'gpt-6-astra', advertised: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'gpt-6-sol', advertised: false, reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'gpt-6-luna', advertised: false, reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'gpt-6.1-sol', advertised: false, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'gpt-5.6-sol', advertised: true, reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'gpt-5.6-terra', advertised: true, reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'gpt-5.6-luna', advertised: true, reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'gpt-5.5', advertised: true, reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'] },
]

/** One model this route serves, and the facts measured about it. */
export interface ServedModel {
  /** The model id to pass on a request. */
  id: string
  /** Whether the account's listing advertises it; `false` means this list is the only source. */
  advertised: boolean
  /**
   * The `reasoning.effort` spellings the model actually accepts.
   *
   * No single source gets this right, which is why it is measured. The account's
   * listing advertised `ultra` for `gpt-6-astra` and the API refused it with
   * `400 invalid_value`; the bundled catalog maps `none` to unsupported for the
   * `gpt-5.6` models, which accept it; and the published model pages agree with
   * neither in every case. A level the model rejects fails the whole request, so
   * this list carries the accepted set rather than a derivation.
   */
  reasoningEfforts: readonly string[]
}

/**
 * The largest context the account's listing advertised for a model in this
 * generation, in tokens.
 *
 * The listing is the authority on what this route will accept, and it caps every
 * model of this generation at this figure. The published model specification is
 * larger — 1,050,000 for every model in the list above — so reporting the
 * specification would let the harness build a request the route refuses.
 *
 * The 272,000 that appears throughout these numbers is not a context limit: the
 * model pages define it as the long-context pricing boundary, above which a
 * request is billed at twice the input rate. It is a threshold, and reading it as
 * a ceiling is what made an earlier version of this plugin compact far too early.
 */
export const ROUTE_MAX_CONTEXT_WINDOW = 872_000

/**
 * The largest output the published specification allows for this generation,
 * matching the bundled catalog.
 */
export const ROUTE_MAX_OUTPUT_TOKENS = 128_000

/** Whether an id was measured as servable on this route. */
export function isServed(id: string): boolean {
  return SERVED_MODELS.some(entry => entry.id === id)
}

/** The measurement recorded for one model, when there is one. */
export function servedRecord(id: string): ServedModel | undefined {
  return SERVED_MODELS.find(entry => entry.id === id)
}
