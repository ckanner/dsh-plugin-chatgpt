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

/** One model entry as the account's listing describes it. */
export interface ListedModel {
  /** The value to pass as `model` on a request. */
  slug: string
  /** Human-readable name for selectors. */
  displayName?: string
  /** The server's `visibility` field; only `list` is meant for display. */
  visibility?: string
}

/** A model the adapter can serve, with everything the harness needs to offer it. */
export interface DescribedModel {
  id: string
  name: string
  contextWindow: number
  maxTokens?: number
  input: readonly ('text' | 'image')[]
  /** Selectable reasoning efforts, adapter-preferred order; absent when the model does not reason. */
  reasoningEfforts?: readonly { id: string, name: string }[]
  /** The effort a request omits an explicit choice for. */
  defaultReasoningEffort?: string
  /** Whether capacities came from the catalog or from the fallback. */
  metadataSource: 'catalog' | 'fallback'
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
 *
 * The wire value is what a request carries; this is only the label, so a map
 * missing an entry still produces a usable selector entry rather than a blank.
 */
const EFFORT_LABELS: Record<string, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

/** The escalation order efforts are offered in, matching the harness's own. */
const EFFORT_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** Read one model's reasoning efforts from its catalog entry. */
function effortsOf(entry: CatalogEntry | undefined): { id: string, name: string }[] {
  if (entry === undefined || !entry.reasoning) return []
  const map = entry.thinkingLevelMap
  if (map === undefined) return []
  const efforts: { id: string, name: string }[] = []
  for (const level of EFFORT_ORDER) {
    // A level mapped to `null` is one the model does not accept; a level mapped
    // to a string is carried on the wire under that spelling.
    const wire = map[level]
    if (wire === null || wire === undefined) continue
    efforts.push({ id: wire, name: EFFORT_LABELS[level] ?? level })
  }
  return efforts
}

/** The effort used when a request names none: the provider's own default ordering. */
function defaultEffortOf(efforts: readonly { id: string, name: string }[]): string | undefined {
  // `medium` is the documented default for the reasoning models that accept it;
  // otherwise the middle of what the model does accept.
  const medium = efforts.find(effort => effort.id === 'medium')
  if (medium !== undefined) return medium.id
  return efforts[Math.floor(efforts.length / 2)]?.id
}

/** Read one model's accepted input modalities. */
function inputOf(entry: CatalogEntry | undefined): ('text' | 'image')[] {
  const declared = entry?.input
  if (declared === undefined || declared.length === 0) return [...FALLBACK.input]
  const kept = declared.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image')
  return kept.length === 0 ? [...FALLBACK.input] : kept
}

/**
 * Describe one listed model.
 *
 * @param listed - what the account's listing reported.
 * @returns everything the harness needs to offer and call the model.
 */
export function describeModel(listed: ListedModel): DescribedModel {
  const entry = CATALOG[listed.slug]
  const efforts = effortsOf(entry)
  const defaultEffort = defaultEffortOf(efforts)
  return {
    id: listed.slug,
    name: listed.displayName ?? entry?.name ?? listed.slug,
    contextWindow: entry?.contextWindow ?? FALLBACK.contextWindow,
    ...entry?.maxTokens === undefined ? {} : { maxTokens: entry.maxTokens },
    input: inputOf(entry),
    ...efforts.length === 0 ? {} : { reasoningEfforts: efforts },
    ...defaultEffort === undefined ? {} : { defaultReasoningEffort: defaultEffort },
    metadataSource: entry === undefined ? 'fallback' : 'catalog',
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
