/** Attach only the verified registry bytes; retries never overwrite a Release. */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { PACKAGE, REPOSITORY, abnormalExit, assertArchive, checked, checkChannel, remoteIntegrity, run } from './release.mjs'

function githubRequest(args, execute, allowMissing = false) {
  const result = execute('gh', ['api', '--include', ...args])
  if (abnormalExit(result)) checked(result, 'Read GitHub Release')
  const match = /^HTTP\/[\d.]+ (\d{3})[^\r\n]*\r?\n[\s\S]*?\r?\n\r?\n([\s\S]*)$/.exec(result.stdout ?? '')
  if (!match) throw new Error('GitHub Release lookup did not return a structured HTTP status and JSON body')
  let body
  try { body = JSON.parse(match[2]) } catch { throw new Error('GitHub Release lookup returned invalid JSON') }
  const status = Number(match[1])
  if (allowMissing && status === 404 && result.status !== 0 && body?.message === 'Not Found') return null
  checked(result, 'Read GitHub Release')
  if (status !== 200 || !body || typeof body !== 'object' || Array.isArray(body)) throw new Error(`Unexpected GitHub Release HTTP status ${status}`)
  return body
}

export function githubRelease(tag, execute = run) {
  const published = githubRequest([`repos/${REPOSITORY}/releases/tags/${tag}`], execute, true)
  if (published !== null) return published
  // The REST tag endpoint only finds published releases. Match the CLI's draft
  // lookup: resolve the pending tag through GraphQL, then read its exact REST ID.
  const [owner, name] = REPOSITORY.split('/')
  const query = 'query($owner:String!,$name:String!,$tag:String!){repository(owner:$owner,name:$name){release(tagName:$tag){databaseId isDraft}}}'
  const response = githubRequest(['graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-f', `tag=${tag}`], execute)
  const repository = response.data?.repository
  if (response.errors !== undefined || !repository || !Object.hasOwn(repository, 'release')) throw new Error('GitHub draft lookup returned an error or incomplete identity')
  const identity = repository.release
  if (identity === null) return null
  if (!Number.isSafeInteger(identity.databaseId) || identity.databaseId <= 0 || typeof identity.isDraft !== 'boolean') throw new Error('Invalid GitHub draft release identity')
  const found = githubRequest([`repos/${REPOSITORY}/releases/${identity.databaseId}`], execute)
  if (found.id !== identity.databaseId || found.tag_name !== tag) throw new Error('GitHub draft lookup changed release identity')
  return found
}

export function validateRelease(release, candidate) {
  if (release.tag_name !== candidate.tag || release.target_commitish !== candidate.sourceSHA
    || release.prerelease !== candidate.prerelease || typeof release.draft !== 'boolean'
    || !Number.isSafeInteger(release.id) || release.id <= 0 || !Array.isArray(release.assets)) {
    throw new Error('Existing GitHub Release has a different source, tag, or prerelease state')
  }
  const assets = release.assets.filter(asset => asset.name === `${PACKAGE}.tgz`)
  if (assets.length > 1 || assets.length !== release.assets.length) throw new Error('Existing GitHub Release has ambiguous or unverified archive assets')
  if (assets.length === 1 && (assets[0].state !== 'uploaded' || assets[0].size !== candidate.bytes
    || !Number.isSafeInteger(assets[0].id) || assets[0].id <= 0)) throw new Error('Existing GitHub Release archive has different size, identity or is incomplete')
  return assets.length === 1
}

export function verifyReleaseAsset(directory, candidate, execute = run) {
  const temporary = mkdtempSync(join(directory, 'github-'))
  try {
    checked(execute('gh', ['release', 'download', candidate.tag, '--repo', REPOSITORY,
      '--pattern', `${PACKAGE}.tgz`, '--dir', temporary]), 'Download the existing GitHub Release archive')
    assertArchive(join(temporary, `${PACKAGE}.tgz`), candidate)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

/** Detect a conflicting Release before any npm publication or channel change. */
export function checkGitHubRelease(directory, candidate, { execute = run, assertSource = () => {} } = {}) {
  assertSource()
  const existing = githubRelease(candidate.tag, execute)
  if (existing !== null && validateRelease(existing, candidate)) {
    verifyReleaseAsset(directory, candidate, execute)
    refreshRelease(candidate, existing, execute)
  }
  return existing
}

function refreshRelease(candidate, previous, execute) {
  const current = githubRelease(candidate.tag, execute)
  if (!current || current.id !== previous.id) throw new Error('GitHub Release identity changed during reconciliation')
  validateRelease(current, candidate)
  if (!previous.draft && current.draft) throw new Error('Published GitHub Release became a draft during reconciliation')
  if (previous.assets.length && current.assets[0]?.id !== previous.assets[0].id) throw new Error('GitHub Release archive identity changed after verification')
  return current
}

export async function recordGitHubRelease(directory, candidate, { execute = run, assertSource = () => {} } = {}) {
  assertSource()
  const file = assertArchive(join(directory, 'registry', `${PACKAGE}.tgz`), candidate)
  if (remoteIntegrity(candidate, execute) === null || checkChannel(candidate, execute) !== candidate.version) {
    throw new Error('The exact registry version must be verified and promoted before recording its Release')
  }
  let existing = githubRelease(candidate.tag, execute)
  if (existing === null) {
    assertSource()
    checked(execute('gh', ['release', 'create', candidate.tag, '--repo', REPOSITORY, '--verify-tag',
      '--target', candidate.sourceSHA, '--title', candidate.tag, '--generate-notes',
      '--draft', '--latest=false', ...(candidate.prerelease ? ['--prerelease'] : [])]), 'Create the exact GitHub Release draft')
    existing = githubRelease(candidate.tag, execute)
    if (!existing) throw new Error('Created GitHub Release is not visible; rerun the exact tag to reconcile')
  }
  if (!validateRelease(existing, candidate)) {
    assertSource()
    existing = refreshRelease(candidate, existing, execute)
    assertArchive(file, candidate)
    if (!validateRelease(existing, candidate)) {
      checked(execute('gh', ['release', 'upload', candidate.tag, file, '--repo', REPOSITORY]), 'Attach the verified registry archive')
      existing = refreshRelease(candidate, existing, execute)
      if (!validateRelease(existing, candidate)) throw new Error('GitHub Release archive is not visible after upload')
    }
  }
  // Downloading also detects a previously uploaded asset whose size matches but
  // content does not. A retry cannot use --clobber to conceal that mismatch.
  verifyReleaseAsset(directory, candidate, execute)
  existing = refreshRelease(candidate, existing, execute)
  if (existing.draft) {
    assertSource()
    existing = refreshRelease(candidate, existing, execute)
    if (existing.draft) {
      // Publish by the verified database ID, never by a tag that could resolve to
      // a replacement draft. A lost response is reconciled on the next run.
      const published = githubRequest(['--method', 'PATCH', `repos/${REPOSITORY}/releases/${existing.id}`,
        '-F', 'draft=false', '-f', `make_latest=${candidate.prerelease ? 'false' : 'true'}`], execute)
      if (published.id !== existing.id || published.draft !== false || !validateRelease(published, candidate)
        || published.assets[0].id !== existing.assets[0].id) throw new Error('GitHub Release publication changed its verified identity')
      existing = published
    }
    verifyReleaseAsset(directory, candidate, execute)
  }
  existing = refreshRelease(candidate, existing, execute)
  if (existing.draft) throw new Error('GitHub Release remained a draft after publication')
  assertSource()
}
