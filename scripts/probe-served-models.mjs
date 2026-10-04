/**
 * Re-measure which models this route actually serves.
 *
 * `src/models/served.ts` is a list of measurements, and a measurement goes stale.
 * The account's listing is not enough to refresh it: the listing omits models the
 * route serves, which is the whole reason that file exists. So the check is the
 * only honest one — ask the endpoint for each candidate and see which answer.
 *
 *   node scripts/probe-served-models.mjs                 # candidates from the bundled catalog
 *   node scripts/probe-served-models.mjs gpt-6-sol …     # explicit candidates
 *
 * It spends the account's plan allowance on one tiny turn per candidate, so treat
 * a run as a deliberate act rather than a routine check.
 *
 * @module dsh-plugin-chatgpt/scripts/probe-served-models
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ChatGptAuth } from '../src/auth/manager.ts'
import { SERVED_MODELS } from '../src/models/served.ts'

const here = dirname(fileURLToPath(import.meta.url))
const stateDir = process.env['CHATGPT_STATE_DIR']
if (stateDir === undefined || stateDir.length === 0) {
  console.error('set CHATGPT_STATE_DIR to the directory holding chatgpt-auth.json')
  process.exit(2)
}

/** The candidates: what was asked for, else every id the bundled catalog knows. */
function candidates() {
  const given = process.argv.slice(2)
  if (given.length > 0) return given
  const catalog = JSON.parse(readFileSync(join(here, '..', 'src', 'models', 'catalog.json'), 'utf8'))
  return [...new Set([...Object.keys(catalog), ...SERVED_MODELS.map(entry => entry.id)])].sort()
}

const auth = new ChatGptAuth({ stateDir, agentNameHint: 'DeepSeek Harness' })
const credential = await auth.usable()

const served = []
const refused = []
for (const model of candidates()) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${credential.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      store: false,
      stream: true,
    }),
  })
  const body = await response.text()
  if (body.includes('response.completed')) {
    served.push(model)
    continue
  }
  const code = body.match(/"code"\s*:\s*"([^"]+)"/)?.[1] ?? `http_${response.status}`
  refused.push(`${model} (${code})`)
}

console.log(`served ${served.length}:`)
for (const model of served) console.log(`  ${model}`)
console.log(`\nrefused ${refused.length}:`)
for (const entry of refused) console.log(`  ${entry}`)
console.log('\nUpdate src/models/served.ts from the served list, and its measurement date.')
