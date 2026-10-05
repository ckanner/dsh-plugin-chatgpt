/**
 * Fail when the published package cannot run.
 *
 * A `files` whitelist is a promise about what the package contains, and nothing
 * checks that promise against what the code actually imports. A list naming the
 * entry points but not their imports therefore ships a package that installs
 * cleanly, composes a layer, and then fails to load — which is exactly what
 * happened here: the tarball carried `lib/index.js` and `lib/client.js` while the
 * twenty modules they import were absent, and the failure only appeared when a
 * profile was actually booted rather than merely composed.
 *
 * So this compares three things that have to agree: the runtime modules the build
 * produced, the files npm would pack, and the patch the bundle needs.
 *
 *   node scripts/verify-package-contents.mjs
 *
 * @module dsh-plugin-chatgpt/scripts/verify-package-contents
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** Every file under one directory, as paths relative to the package root. */
function walk(directory) {
  const found = []
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) visit(path)
      else found.push(relative(root, path))
    }
  }
  visit(directory)
  return found
}

/** The files npm would publish, from its own dry run. */
function packedFiles() {
  // --ignore-scripts: the report is about which files would ship, and the build
  // output it reads is already on disk. Letting `prepare` run would also mix build
  // progress into the JSON on stdout.
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    // npm writes its notices to stderr; only the JSON report on stdout is read.
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  // Tolerant of any notice a future npm version adds around the report.
  const report = JSON.parse(raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1))
  const entry = report[0]
  if (entry === undefined) throw new Error('npm pack reported no package')
  return { files: new Set(entry.files.map(file => file.path)), entry }
}

const { files, entry } = packedFiles()
const problems = []

// The host half loads its imports at run time, so every compiled module and every
// data file the build emitted has to travel with it.
for (const path of walk(join(root, 'lib'))) {
  if (!/\.(?:js|json)$/.test(path)) continue
  if (!files.has(path)) problems.push(`${path} is built but would not be published`)
}

// Without the patch there is no bundle layer to compose, and the install would
// look successful while contributing nothing.
if (!files.has('cordis.patch.yml')) problems.push('cordis.patch.yml would not be published')

// A published package that cannot be imported is worse than one that fails to
// install, because the install reports success.
if (!files.has('lib/index.js')) problems.push('lib/index.js (the host entry) would not be published')
if (!files.has('lib/client.js')) problems.push('lib/client.js (the browser bundle) would not be published')

if (problems.length > 0) {
  console.error(`package contents would not run (${String(problems.length)} problem(s)):`)
  for (const problem of problems) console.error(`  ${problem}`)
  console.error(`\npacked ${String(entry.files.length)} files, ${String(entry.size)} bytes`)
  process.exit(1)
}

console.log(
  `package contents verified: ${String(entry.files.length)} files, `
  + `${String(entry.size)} bytes, every lib module and the bundle patch included`,
)
