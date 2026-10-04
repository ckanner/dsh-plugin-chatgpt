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
export const SERVED_MODELS: readonly { id: string, advertised: boolean }[] = [
  { id: 'gpt-6-astra', advertised: true },
  { id: 'gpt-6-sol', advertised: false },
  { id: 'gpt-6-luna', advertised: false },
  { id: 'gpt-6.1-sol', advertised: false },
  { id: 'gpt-5.6-sol', advertised: true },
  { id: 'gpt-5.6-terra', advertised: true },
  { id: 'gpt-5.6-luna', advertised: true },
  { id: 'gpt-5.5', advertised: true },
]

/** Whether an id was measured as servable on this route. */
export function isServed(id: string): boolean {
  return SERVED_MODELS.some(entry => entry.id === id)
}
