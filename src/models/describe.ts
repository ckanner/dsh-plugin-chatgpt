/**
 * Describing the models an account may use.
 *
 * Two facts come from two different places and neither source has both. The
 * subscription endpoint is authoritative about *availability* — it answers what
 * this exact account on this exact plan may call right now — but it describes a
 * model with a slug and a display name and nothing else. The bundled catalog
 * knows capacities and reasoning spellings but cannot know what a given account
 * is entitled to.
 *
 * So availability always comes from the account, and metadata is filled in from
 * the catalog by exact id. A model the catalog has never heard of is not
 * dropped: it is still callable, and a plausible default beats refusing to show
 * a model the account can demonstrably use. The unknown case is where the
 * shipped `catalog.json` earns its keep, and a model that stays unknown is
 * visible as exactly that.
 *
 * @module dsh-plugin-chatgpt/models/describe
 */

import catalog from './catalog.json' with { type: 'json' }

/**
 * One model entry as the account's listing describes it.
 *
 * The endpoint returns far more than the published documentation suggests — it
 * describes capacities, reasoning levels, and modalities itself. Those fields
 * are optional here because a listing from another implementation of the same
 * shape may omit them, not because this endpoint does.
 */
export interface ListedModel {
  /** The value to pass as `model` on a request. */
  slug: string
  /** Human-readable name for selectors. */
  displayName?: string
  /** The server's `visibility` field; only `list` is meant for display. */
  visibility?: string
  /** One-line description from the endpoint. */
  description?: string
  /** Context capacity the endpoint reports for this model. */
  contextWindow?: number
  /** The largest context the model can be extended to, when it says. */
  maxContextWindow?: number
  /** Accepted request modalities. */
  inputModalities?: readonly string[]
  /** The effort a request that names none is given. */
  defaultReasoningLevel?: string
  /** The reasoning efforts the model accepts, in the endpoint's order. */
  reasoningLevels?: readonly { effort: string, description?: string }[]
}

/** A model the adapter can serve, with everything the harness needs to offer it. */
export interface DescribedModel {
  id: string
  name: string
  contextWindow: number
  /** The largest context the model can be extended to, when the endpoint says. */
  maxContextWindow?: number
  /** Output cap, known only from the bundled catalog. */
  maxTokens?: number
  /** One-line description from the endpoint. */
  description?: string
  input: readonly ('text' | 'image')[]
  /** Selectable reasoning efforts, adapter-preferred order; absent when the model does not reason. */
  reasoningEfforts?: readonly { id: string, name: string }[]
  /** The effort a request omits an explicit choice for. */
  defaultReasoningEffort?: string
  /**
   * Where this description came from: the endpoint itself, a measurement of what
   * this route serves, the bundled catalog, or a conservative default.
   */
  metadataSource: 'endpoint' | 'measured' | 'catalog' | 'fallback'
}

/** One catalog entry. */
interface CatalogEntry {
  name: string
  contextWindow: number
  maxTokens?: number
  reasoning: boolean
  thinkingLevelMap?: Record<string, string | null>
  input?: string[]
}

const CATALOG = catalog as Record<string, CatalogEntry>

/**
 * Capacities assumed when the catalog does not describe a model.
 *
 * Deliberately conservative and deliberately visible: a model reported with
 * `metadataSource: 'fallback'` is one the UI cannot describe precisely, which is
 * a truthful thing to show rather than a silently invented number.
 */
const FALLBACK = {
  contextWindow: 128000,
  maxTokens: 16384,
  input: ['text'] as const,
}

/**
 * How a reasoning effort is spelled for a human.

/** How a reasoning effort is spelled for a human. */
const EFFORT_LABELS: Record<string, string> = {
  off: 'Off',
  none: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
}

/** The escalation order efforts are offered in when nothing else orders them. */
const EFFORT_ORDER = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

/**
 * Label one reasoning effort, falling back to its own wire spelling.
 * @param effort - the `reasoning.effort` value.
 * @returns the text a selector shows.
 */
export function effortLabel(effort: string): string {
  return EFFORT_LABELS[effort] ?? effort
}

/** Order efforts by the canonical escalation, keeping any unknown ones at the end. */
function ordered(efforts: readonly { id: string, name: string, description?: string }[]) {
  const rank = (id: string): number => {
    const at = EFFORT_ORDER.indexOf(id as typeof EFFORT_ORDER[number])
    return at === -1 ? EFFORT_ORDER.length : at
  }
  return [...efforts].sort((left, right) => rank(left.id) - rank(right.id))
}

/**
 * The reasoning efforts a model accepts.
 *
 * The bundled catalog's per-model map is treated as the authority, and the
 * account's listing is intersected with it. That ordering is not a preference: on
 * a live account the listing advertised `ultra` for `gpt-6-astra`, and the API
 * answered a request carrying it with `400 invalid_value` — while its error text
 * enumerated exactly the set the catalog already had. A listing entry is
 * advisory; a level the model rejects fails the whole request.
 *
 * When the listing names levels the catalog does not describe at all, the
 * intersection would hide a level that may well be real. That is the safer
 * mistake: a missing choice costs a selection, an invalid one costs the turn.
 *
 * @param listed - what the account's listing reported.
 * @param entry - the bundled catalog's entry, when it has one.
 * @returns the efforts to offer, in escalation order.
 */
function effortsOf(listed: ListedModel, entry: CatalogEntry | undefined) {
  const fromCatalog = acceptedByCatalog(entry)
  const fromListing = (listed.reasoningLevels ?? [])
    .filter(level => level.effort.length > 0)
    .map(level => ({
      id: level.effort,
      name: effortLabel(level.effort),
      ...level.description === undefined ? {} : { description: level.description },
    }))

  if (fromCatalog === undefined) return ordered(fromListing)
  if (fromListing.length === 0) return ordered(fromCatalog)
  const accepted = new Set(fromCatalog.map(effort => effort.id))
  const checked = fromListing.filter(effort => accepted.has(effort.id))
  // An empty intersection means the two sources disagree completely; the
  // catalog's set is the one that does not produce a rejected request.
  return ordered(checked.length > 0 ? checked : fromCatalog)
}

/**
 * The efforts the bundled catalog says a model accepts, or `undefined` when the
 * catalog does not describe the model.
 */
function acceptedByCatalog(entry: CatalogEntry | undefined): { id: string, name: string }[] | undefined {
  if (entry === undefined) return undefined
  if (!entry.reasoning) return []
  const map = entry.thinkingLevelMap
  if (map === undefined) return undefined
  const efforts: { id: string, name: string }[] = []
  for (const level of EFFORT_ORDER) {
    // A level mapped to `null` is one the model does not accept; a level mapped
    // to a string is carried on the wire under that spelling.
    const wire = map[level]
    if (wire === null || wire === undefined) continue
    efforts.push({ id: wire, name: effortLabel(level) })
  }
  return efforts
}

/** The effort used when a request names none. */
function defaultEffortOf(
  listed: ListedModel,
  efforts: readonly { id: string, name: string }[],
): string | undefined {
  if (listed.defaultReasoningLevel !== undefined
    && efforts.some(effort => effort.id === listed.defaultReasoningLevel)) {
    return listed.defaultReasoningLevel
  }
  const medium = efforts.find(effort => effort.id === 'medium')
  if (medium !== undefined) return medium.id
  return efforts[Math.floor(efforts.length / 2)]?.id
}

/** The modalities a model accepts, preferring what the endpoint declared. */
function inputOf(listed: ListedModel, entry: CatalogEntry | undefined): ('text' | 'image')[] {
  const declared = listed.inputModalities ?? entry?.input
  if (declared === undefined || declared.length === 0) return [...FALLBACK.input]
  const kept = declared.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image')
  return kept.length === 0 ? [...FALLBACK.input] : kept
}

/**
 * Describe one listed model.
 *
 * Metadata comes from the endpoint that listed it whenever the endpoint supplied
 * it, and from the bundled catalog otherwise. The catalog is a fallback, not the
 * primary source: treating it as primary would let a stale snapshot override the
 * live description of a model the account is actually entitled to.
 *
 * @param listed - what the account's listing reported.
 * @returns everything the harness needs to offer and call the model.
 */
export function describeModel(listed: ListedModel): DescribedModel {
  const entry = CATALOG[listed.slug]
  // Whether the listing itself described this model, rather than only naming it.
  const describedByEndpoint = listed.contextWindow !== undefined
    || (listed.reasoningLevels !== undefined && listed.reasoningLevels.length > 0)
    || listed.inputModalities !== undefined
  const efforts = effortsOf(listed, entry)
  const defaultEffort = defaultEffortOf(listed, efforts)
  const contextWindow = listed.contextWindow ?? entry?.contextWindow ?? FALLBACK.contextWindow
  const maxTokens = entry?.maxTokens
  return {
    id: listed.slug,
    name: listed.displayName ?? entry?.name ?? listed.slug,
    contextWindow,
    ...listed.maxContextWindow === undefined ? {} : { maxContextWindow: listed.maxContextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...listed.description === undefined ? {} : { description: listed.description },
    input: inputOf(listed, entry),
    ...efforts.length === 0 ? {} : { reasoningEfforts: efforts },
    ...defaultEffort === undefined ? {} : { defaultReasoningEffort: defaultEffort },
    // Where the description comes from, named honestly: the endpoint described it,
    // the bundled catalog did, or neither could and a conservative default stands
    // in. A catalog entry that merely happens to exist does not make this an
    // endpoint description.
    metadataSource: describedByEndpoint ? 'endpoint' : entry === undefined ? 'fallback' : 'catalog',
  }
}

/**
 * Keep only the entries meant for display, preserving the server's order.
 *
 * The order is the server's ranking of what this account should reach for
 * first, so it is worth preserving rather than imposing an alphabetical one.
 *
 * @param listed - every entry the listing returned.
 * @returns the describable models, in the order the server gave.
 */
export function describableModels(listed: readonly ListedModel[]): DescribedModel[] {
  return listed
    .filter(model => model.visibility === undefined || model.visibility === 'list')
    .filter(model => model.slug.length > 0)
    .map(describeModel)
}
