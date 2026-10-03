/**
 * Regenerate `src/models/catalog.json` from the pi-ai model catalog.
 *
 * The subscription endpoint lists which models an account may use, but it does
 * not describe them: `GET /v1/models` names a slug and a display name and stops
 * there. Everything the harness needs to *use* a model — how much context it
 * holds, how much it may emit, whether it reasons, and which effort spellings it
 * accepts — has to come from somewhere else.
 *
 * pi-ai ships that metadata for the OpenAI family and is MIT licensed, so this
 * script derives the table instead of hand-copying numbers that would silently
 * rot. Re-run it when the upstream catalog moves:
 *
 *   node scripts/generate-model-catalog.mjs            # from a filtered install
 *   node scripts/generate-model-catalog.mjs <pi-ai-dir>
 *
 * @module dsh-plugin-chatgpt/scripts/generate-model-catalog
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const target = join(here, '..', 'src', 'models', 'catalog.json')

/** The pi-ai package directory, from argv or the nearest resolution. */
async function resolvePiAi() {
  const given = process.argv[2]
  if (given !== undefined) return given
  try {
    return dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-ai/package.json')))
  } catch {
    throw new Error(
      'cannot locate @earendil-works/pi-ai; pass its directory as the first argument',
    )
  }
}

/** Keep the entries whose fields this plugin actually reads. */
function normalize(models) {
  const entries = {}
  for (const model of models) {
    if (model.id === undefined || model.contextWindow === undefined) continue
    entries[model.id] = {
      name: model.name ?? model.id,
      contextWindow: model.contextWindow,
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      reasoning: model.reasoning === true,
      ...model.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: model.thinkingLevelMap },
      ...model.input === undefined ? {} : { input: model.input },
    }
  }
  return Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)))
}

const piAiDir = await resolvePiAi()
const module = await import(join(piAiDir, 'dist', 'providers', 'openai.models.js'))
const catalog = normalize(Object.values(module.OPENAI_MODELS))

writeFileSync(target, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
const count = Object.keys(catalog).length
console.log(`wrote ${count} models to ${target}`)
console.log(`source: ${join(piAiDir, 'dist/providers/openai.models.js')}`)
