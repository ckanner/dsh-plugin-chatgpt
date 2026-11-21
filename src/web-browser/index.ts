/** Visible-UI Chrome transport. The caller, not this module, owns Chrome. */
import { realpath } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, type Browser, type Locator, type Page } from 'playwright-core'
import { WebBridgeError, type PageRecovery, type PageTurn, type WebPageTransport } from '../web-bridge/contracts.ts'
import { attachmentBytes, validateAttachmentVersions } from '../web-bridge/attachments.ts'
import { canonical, requestHash, WEB_MAX_JSON_BYTES, WEB_MAX_REQUEST_BYTES } from '../web-bridge/protocol.ts'
import { BrowserLedger, textDigest, type BrowserGeneration, type BrowserLedgerFault, type BrowserMessageEvidence } from './ledger.ts'
import { COMPOSER, MODEL_TRIGGER, PROFILE_TRIGGER, readPageEvidence, readProjectEvidence, readUploads, type PageEvidence } from './dom.ts'
import { parseResponse, projectionSettingsDigest, renderPrompt } from './envelope.ts'

export interface ChromeConnectionOptions {
  cdpUrl: string
  expectedProfileDirectory: string
  /** Attach to a user-launched Chrome; do not claim, lock or close its process. */
  attached?: boolean
  /** Isolated test servers only. Production setup never accepts this from wire input. */
  testOnlyOrigin?: string
  timeoutMs?: number
}
export interface ChromePageTransportOptions extends ChromeConnectionOptions {
  stateDirectory: string
  expectedAccountBinding: string
  provider: string
  profileId: string
  /** Optional legacy isolation; default false uses a fresh ordinary Chat, like Oracle. */
  projectIsolation?: boolean
  initialize?: boolean
  /** Byte admission budget for the complete rendered prompt, not model context capacity. */
  maxInputBytes?: number
  /** Local fault injection only; never accepted through the HTTP protocol. */
  testOnlyLedgerFault?: BrowserLedgerFault
}
export interface BrowserSetupEvidence {
  ready: boolean
  visibleAccount?: string
  accountBinding?: string
  model?: string
  effort?: string
  /** Observed Pro reasoning capability, never a claim about the subscription plan. */
  proAvailable: boolean
  isPro: boolean
  issues: string[]
}
export interface ChromePageTransport extends WebPageTransport {
  inspectSetup(): Promise<BrowserSetupEvidence>
  recover(turn: PageTurn): Promise<PageRecovery>
  discard(turn: PageTurn): Promise<void>
  close(): Promise<void>
}

const UI_TIMEOUT = 10_000
const DEFAULT_RESPONSE_TIMEOUT = 10 * 60_000
const DEFAULT_INPUT_BYTES = 256 * 1024
/** Constructed only after durable proof of a strictly observed terminal response. */
class TerminalResponseFailure extends WebBridgeError {
  constructor() { super('WEB_INVALID_RESPONSE', 'The exact completed website response violated the required protocol; its immutable terminal evidence was recorded.', 502) }
}
function failure(code: string, message: string): never { throw new WebBridgeError(code, message, 409) }
function drift(message: string): never { return failure('WEB_BROWSER_DRIFT', message) }
function check(signal: AbortSignal): void { signal.throwIfAborted() }
function visible(locator: Locator): Locator { return locator.filter({ visible: true }) }
async function unique(locator: Locator, message: string): Promise<Locator> {
  const result = visible(locator)
  if (await result.count() !== 1) drift(message)
  return result
}
async function poll<T>(read: () => Promise<T | undefined>, signal: AbortSignal, timeout = UI_TIMEOUT): Promise<T> {
  const deadline = Date.now() + timeout
  for (;;) {
    check(signal)
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() >= deadline) failure('WEB_BROWSER_TIMEOUT', 'The expected visible browser evidence did not arrive before the deadline')
    await delay(80, undefined, { signal })
  }
}
function originFor(options: ChromeConnectionOptions): string {
  if (options.testOnlyOrigin === undefined) return 'https://chatgpt.com'
  const url = new URL(options.testOnlyOrigin)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    failure('WEB_BROWSER_SETUP', 'The test origin must be an explicit literal loopback HTTP origin')
  }
  return url.origin
}
function boundUrl(value: string, origin: string): URL {
  const url = new URL(value)
  if (url.origin !== origin || url.username || url.password || url.search || url.hash) drift('The browser escaped the exact bound origin or acquired an unrecognized route')
  return url
}
function conversationUrl(value: string, origin: string): boolean {
  return /^\/(?:g\/g-p-[a-zA-Z0-9-]+\/)?c\/[a-zA-Z0-9-]+$/.test(boundUrl(value, origin).pathname)
}
function projectUrl(value: string, origin: string): boolean {
  return /^\/g\/g-p-[a-zA-Z0-9-]+\/project$/.test(boundUrl(value, origin).pathname)
}

export function accountBindingForVisibleIdentity(identity: string): string {
  const normalized = identity.trim().toLowerCase()
  // Current ChatGPT profile menus expose a display name instead of an email.
  // Both forms are visible, single-account evidence; never read cookie/token data.
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(normalized)
    && !/^[\p{L}\p{N}][\p{L}\p{N} ._-]{1,79}$/u.test(normalized)) {
    failure('WEB_BROWSER_ACCOUNT', 'A unique visible account identity is required for this adapter version')
  }
  return textDigest(`chatgpt-visible-account-v1\n${normalized}`)
}

async function connect(options: ChromeConnectionOptions): Promise<{ browser: Browser, page: Page, origin: string }> {
  const endpoint = new URL(options.cdpUrl)
  if (!['http:', 'ws:'].includes(endpoint.protocol) || endpoint.hostname !== '127.0.0.1' || !endpoint.port
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || endpoint.protocol === 'http:' && endpoint.pathname !== '/'
    || endpoint.protocol === 'ws:' && !/^\/devtools\/browser(?:\/[a-zA-Z0-9-]+)?$/.test(endpoint.pathname)) {
    failure('WEB_BROWSER_SETUP', 'Chrome must expose its dedicated CDP endpoint on literal loopback')
  }
  const origin = originFor(options)
  const browser = await chromium.connectOverCDP(endpoint.href, { timeout: options.attached === true ? 30_000 : UI_TIMEOUT })
  try {
    if (options.attached !== true) {
      const session = await browser.newBrowserCDPSession()
      let args: string[]
      try { args = (await session.send('Browser.getBrowserCommandLine')).arguments }
      finally { await session.detach() }
      const profiles = args.filter(value => value.startsWith('--user-data-dir='))
      if (profiles.length !== 1
        || await realpath(profiles[0]!.slice('--user-data-dir='.length)) !== await realpath(options.expectedProfileDirectory)) {
        failure('WEB_BROWSER_OWNERSHIP', 'CDP did not prove the expected dedicated physical Chrome profile')
      }
    }
    if (browser.contexts().length !== 1) failure('WEB_BROWSER_OWNERSHIP', 'The dedicated Chrome instance has unexpected additional contexts')
    const candidates = browser.contexts()[0]!.pages().filter(page => { try { return new URL(page.url()).origin === origin } catch { return false } })
    if (candidates.length !== 1) failure('WEB_BROWSER_SETUP', 'Exactly one ChatGPT page must be open in the dedicated profile')
    const page = candidates[0]!
    await page.bringToFront()
    boundUrl(page.url(), origin)
    page.setDefaultTimeout(UI_TIMEOUT)
    page.setDefaultNavigationTimeout(UI_TIMEOUT)
    return { browser, page, origin }
  } catch (error) { await browser.close(); throw error }
}

async function dismiss(page: Page, knownDialogs = false): Promise<void> {
  const countOverlays = () => page.evaluate(allowDialogs => [...document.querySelectorAll<HTMLElement>('[role="menu"],[role="dialog"],[data-radix-menu-content]')]
    .filter(node => node.getClientRects().length > 0 && !node.closest('[hidden],[aria-hidden="true"],[data-message-author-role]'))
    .filter(node => node.getAttribute('role') !== 'dialog' || allowDialogs && (
      node.querySelector('[data-testid="project-memory-mode"],[data-project-memory],[data-testid="project-sharing-mode"],textarea[name="instructions"],[data-reasoning-slider],[data-model-picker-power-slider]')
      || [...node.querySelectorAll('[role="radio"],[role="menuitemradio"],[role="menuitem"],button')].some(item => /^(GPT-6|Pro|Log out|Sign out|注销|退出登录)$/.test(item.textContent?.trim() ?? '')))).length, knownDialogs)
  for (let step = 0; step < 4; step++) {
    const count = await countOverlays()
    if (count === 0) return
    // Never send an extra Escape through to the composer. On some websites that
    // shortcut stops generation, which would be an unjournaled remote action.
    await page.keyboard.press('Escape')
    const deadline = Date.now() + 500
    while (await countOverlays() >= count) {
      if (Date.now() >= deadline) drift('A read-only menu did not acknowledge closing')
      await delay(20)
    }
  }
  drift('A read-only menu did not close in the supported layout')
}
async function inspectAccount(page: Page, signal: AbortSignal): Promise<string> {
  await dismiss(page)
  check(signal)
  const trigger = await unique(page.locator(PROFILE_TRIGGER), 'The visible account menu is unavailable or ambiguous')
  await trigger.click()
  try {
    return await poll(async () => {
      const values = (await page.evaluate(readPageEvidence)).accountIdentities
      if (values.length > 1) drift('The visible account identity is ambiguous')
      return values.length === 1 ? values[0] : undefined
    }, signal)
  } finally { await dismiss(page, true) }
}

/** Menu opening is observation. This function never selects a persistent value. */
async function inspectModel(page: Page, signal: AbortSignal): Promise<{ model?: string, effort?: string, proAvailable: boolean }> {
  await dismiss(page)
  const trigger = await unique(page.locator(MODEL_TRIGGER), 'The visible model control is unavailable or ambiguous')
  check(signal)
  await trigger.click()
  let model: string | undefined
  let effort: string | undefined
  let proAvailable = false
  const opened = new Set<string>()
  try {
    for (let step = 0; step < 6; step++) {
      check(signal)
      const facts = await page.evaluate(readPageEvidence)
      if (facts.model !== null) { if (model !== undefined && model !== facts.model) drift('The model selection changed while it was inspected'); model = facts.model }
      if (facts.effort !== null) { if (effort !== undefined && effort !== facts.effort) drift('The reasoning selection changed while it was inspected'); effort = facts.effort }
      proAvailable ||= await visible(page.locator('[role="menu"] [role="radio"],[role="menu"] [role="menuitemradio"],[role="menu"] [role="menuitem"],[role="dialog"] [role="radio"]')).filter({ hasText: /^Pro$/ }).count() > 0 || facts.effort === 'Pro'
      if (model !== undefined && effort !== undefined) return { model, effort, proAvailable }
      const desired = model === undefined ? /^(Advanced|高级|高级设置|(?:Model|模型)\s*GPT-[\w.-]+)$/i : /^(Effort|思考强度|思考等级|推理强度)(?:\s*.*)?$/i
      const openers = visible(page.locator('[role="menu"] [role="menuitem"][aria-haspopup="menu"],[role="menu"] button[aria-haspopup="menu"],button[data-model-picker-advanced]')).filter({ hasText: desired })
      if (await openers.count() !== 1) break
      const label = await openers.innerText()
      if (opened.has(label)) break
      opened.add(label)
      await openers.click()
    }
    return { ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }), proAvailable }
  } finally { await dismiss(page, true) }
}

async function setupEvidence(page: Page, origin: string, signal: AbortSignal): Promise<BrowserSetupEvidence> {
  const issues: string[] = []
  const evidence: BrowserSetupEvidence = { ready: false, proAvailable: false, isPro: false, issues }
  try {
    boundUrl(page.url(), origin)
    evidence.visibleAccount = await inspectAccount(page, signal)
    evidence.accountBinding = accountBindingForVisibleIdentity(evidence.visibleAccount)
  } catch { issues.push('Sign in to one account in the dedicated Chrome profile and leave its account menu available.') }
  try {
    const model = await inspectModel(page, signal)
    if (model.model !== undefined) evidence.model = model.model
    if (model.effort !== undefined) evidence.effort = model.effort
    evidence.proAvailable = model.proAvailable
    evidence.isPro = model.model === 'GPT-6' && model.effort === 'Pro'
    if (!evidence.isPro) issues.push('Select GPT-6 and Pro in the visible model controls; unknown controls are unsupported.')
  } catch { issues.push('The visible GPT-6 Pro controls could not be verified in this layout.') }
  const facts = await page.evaluate(readPageEvidence)
  if (!facts.composer.ready || facts.composer.count !== 1) issues.push('A unique ready message composer is required.')
  if (facts.active || facts.hostedTools || facts.error) issues.push('Finish the active response and disable hosted app, agent, or research modes.')
  evidence.ready = issues.length === 0
  return evidence
}

export async function inspectChromeSetup(options: ChromeConnectionOptions): Promise<BrowserSetupEvidence> {
  const connection = await connect(options)
  try { return await setupEvidence(connection.page, connection.origin, AbortSignal.timeout(options.timeoutMs ?? 30_000)) }
  finally { if (options.attached !== true) await connection.browser.close() }
}

function transcript(facts: PageEvidence): BrowserMessageEvidence[] {
  return facts.messages.map(message => ({ id: message.id, role: message.role, digest: textDigest(canonical({ text: message.text, attachments: message.attachments }, WEB_MAX_REQUEST_BYTES)) }))
}

class Transport implements ChromePageTransport {
  private closed = false
  private busy = false
  private prepared: { turnId: string, url: string, prompt: string } | undefined
  private readonly options: ChromePageTransportOptions
  private readonly browser: Browser
  private readonly page: Page
  private readonly origin: string
  private readonly projectIsolation: boolean
  private readonly ledger: BrowserLedger
  constructor(options: ChromePageTransportOptions, browser: Browser, page: Page, origin: string, ledger: BrowserLedger) {
    this.options = options; this.browser = browser; this.page = page; this.origin = origin; this.ledger = ledger
    this.projectIsolation = options.projectIsolation === true
  }

  private async exclusive<T>(body: () => Promise<T>): Promise<T> {
    if (this.closed || this.busy) failure('WEB_BROWSER_BUSY', 'The browser transport is closed or already inspecting an operation')
    this.busy = true
    try { return await body() } finally { this.busy = false }
  }
  private signal(signal: AbortSignal): AbortSignal { return AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_RESPONSE_TIMEOUT)]) }
  private budget(): number { return this.options.maxInputBytes ?? DEFAULT_INPUT_BYTES }
  private admitted(turn: PageTurn): void {
    const request = turn.request
    if (request.accountBinding !== this.options.expectedAccountBinding || request.provider !== this.options.provider || request.profileId !== this.options.profileId) failure('WEB_BROWSER_ACCOUNT', 'The admitted request does not match this browser binding')
    if (request.model !== 'gpt-6-pro-web' || request.reasoningEffort !== 'pro' || Object.keys(request.controls).length) failure('WEB_BROWSER_MODEL', 'The website request requires unsupported model controls')
    if (requestHash(request) !== request.idempotencyKey) failure('WEB_BROWSER_PREPARE', 'The request no longer matches its admitted immutable identity')
    if (validateAttachmentVersions(request.attachmentVersions).some(version => version.base64 === undefined)) failure('WEB_INVALID_ATTACHMENT', 'The engine must hydrate exact image bytes before browser admission')
  }
  private async facts(): Promise<PageEvidence> {
    boundUrl(this.page.url(), this.origin)
    const facts = await this.page.evaluate(readPageEvidence)
    boundUrl(facts.url, this.origin)
    if (facts.ambiguousMessages) drift('The visible transcript contains duplicate or unknown message identities')
    if (facts.ambiguousSelection) drift('The visible model selection contains contradictory current values')
    if (facts.messages.some(message => message.unknownAttachments)) drift('The visible transcript contains unknown or ambiguous attachments')
    return facts
  }
  private async binding(signal: AbortSignal, expectedUrl?: string, allowActive = false): Promise<PageEvidence> {
    check(signal)
    if (expectedUrl !== undefined && this.page.url() !== expectedUrl) drift('The browser moved away from the prepared page')
    if (accountBindingForVisibleIdentity(await inspectAccount(this.page, signal)) !== this.options.expectedAccountBinding) failure('WEB_BROWSER_ACCOUNT', 'The signed-in account differs from the verified binding')
    const selected = await inspectModel(this.page, signal)
    if (selected.model !== 'GPT-6' || selected.effort !== 'Pro') failure('WEB_BROWSER_MODEL', 'The selected model and reasoning effort are not exactly GPT-6 Pro')
    if (accountBindingForVisibleIdentity(await inspectAccount(this.page, signal)) !== this.options.expectedAccountBinding) failure('WEB_BROWSER_ACCOUNT', 'The account changed while its model binding was inspected')
    const facts = await this.facts()
    if (facts.model !== null && facts.model !== 'GPT-6' || facts.effort !== null && facts.effort !== 'Pro') failure('WEB_BROWSER_MODEL', 'The visible current model selection changed during binding inspection')
    if (expectedUrl !== undefined && facts.url !== expectedUrl) drift('The browser moved while its binding was inspected')
    if (facts.hostedTools) drift('Hosted tools, apps, or agent mode are active')
    if (facts.error) failure('WEB_BROWSER_PAGE_ERROR', 'The website displays an error; inspect the dedicated browser before continuing')
    if (!allowActive && facts.active) drift('The website is already generating a response')
    return facts
  }
  private async mutation<T>(turn: PageTurn, kind: string, signal: AbortSignal, action: () => Promise<T>, evidence: (value: T) => Record<string, string>): Promise<T> {
    check(signal)
    const intent = await this.ledger.begin(turn.turnId, kind, this.page.url())
    check(signal)
    const result = await action()
    check(signal)
    await this.ledger.observed(intent, evidence(result))
    return result
  }
  private async ready(signal: AbortSignal): Promise<PageEvidence> {
    return poll(async () => { const facts = await this.facts(); return facts.composer.count === 1 && facts.composer.ready ? facts : undefined }, signal)
  }
  private async navigate(url: string, signal: AbortSignal): Promise<void> {
    boundUrl(url, this.origin); check(signal)
    if (this.page.url() !== url) await this.page.goto(url, { waitUntil: 'domcontentloaded' })
    await this.ready(signal)
  }
  private generation(turn: PageTurn): BrowserGeneration | undefined { return this.ledger.generation(turn.generationId) }
  private ensureTranscript(facts: PageEvidence, generation: BrowserGeneration): void {
    if (canonical(transcript(facts), WEB_MAX_REQUEST_BYTES) !== canonical(generation.transcript, WEB_MAX_REQUEST_BYTES)) failure('WEB_BROWSER_HISTORY', 'The visible website transcript differs from the recorded generation prefix')
  }

  private async verifyProject(generation: BrowserGeneration, signal: AbortSignal): Promise<void> {
    if (!generation.projectUrl || !projectUrl(generation.projectUrl, this.origin)) drift('The generation has no owned Project identity')
    const returnUrl = this.page.url()
    const current = await this.facts()
    if (returnUrl !== generation.projectUrl && current.projectUrl !== generation.projectUrl) drift('The chat does not visibly belong to its owned Project')
    await this.navigate(generation.projectUrl, signal)
    try {
      const project = await this.page.evaluate(readProjectEvidence)
      const chats = [...new Set(project.chats)]
      if (!project.emptySources || chats.some(url => url !== generation.conversationUrl)) drift('The owned Project has other conversations, sources, or unknown empty-state evidence')
      const title = (await this.facts()).projectTitle
      if (title !== generation.title) drift('The visible Project name differs from the owned generation')
      await (await unique(this.page.locator('button[data-testid="project-menu-button"],button[aria-label="Open project menu"],button[aria-label="打开项目菜单"]'), 'Project settings are unavailable')).click()
      await (await unique(this.page.locator('[role="menu"] [role="menuitem"],[role="menu"] button').filter({ hasText: /^(Project settings|项目设置)$/ }), 'The Project settings menu is unknown')).click()
      const settings = await poll(async () => { const value = await this.page.evaluate(readProjectEvidence); return value.projectOnly && value.emptyInstructions ? value : undefined }, signal)
      if (!settings.projectOnly || !settings.emptyInstructions) drift('The Project does not prove project-only memory with empty instructions')
      await dismiss(this.page, true)
      await (await unique(this.page.locator('header button,[data-testid="project-page"] button').filter({ hasText: /^(Share|Share project|共享|分享项目)$/ }), 'Project sharing controls are unavailable')).click()
      await poll(async () => (await this.page.evaluate(readProjectEvidence)).private ? true : undefined, signal)
    } finally {
      await dismiss(this.page, true)
      if (this.page.url() !== returnUrl) await this.navigate(returnUrl, signal)
    }
  }

  async inspectSetup(): Promise<BrowserSetupEvidence> {
    return this.exclusive(() => setupEvidence(this.page, this.origin, AbortSignal.timeout(30_000)))
  }

  async prepare(turn: PageTurn, originalSignal: AbortSignal): Promise<void> {
    return this.exclusive(async () => {
      const signal = this.signal(originalSignal)
      this.prepared = undefined
      if (this.ledger.turn(turn.turnId)?.discarded) failure('WEB_BROWSER_DISCARDED', 'An explicitly discarded website request is never resubmitted')
      if (this.ledger.turn(turn.turnId)?.terminalFailure) failure('WEB_BROWSER_TERMINAL', 'A terminally invalid website response is never submitted again under the same identity')
      if (this.ledger.pending()) failure('WEB_BROWSER_UNCERTAIN', 'An unresolved browser mutation fences further submission')
      this.admitted(turn)
      const generation = this.generation(turn)
      const prompt = renderPrompt(turn, this.budget(), generation)
      if (this.projectIsolation) {
        if (generation?.conversationUrl) {
          await this.navigate(generation.conversationUrl, signal)
          await this.verifyProject(generation, signal)
        }
      } else if (generation?.conversationUrl) {
        await this.navigate(generation.conversationUrl, signal)
      } else {
        // Ordinary Chat mode: use the homepage's fresh composer. No Project is
        // created or claimed; the conversation boundary is the exact URL and
        // transcript evidence recorded after Send.
        await this.navigate(`${this.origin}/`, signal)
      }
      const facts = await this.binding(signal)
      if (facts.composer.count !== 1 || !facts.composer.ready || facts.composer.text.trim()) drift('The prepared composer must be unique, ready, and empty')
      const uploads = await this.page.evaluate(readUploads)
      if (!uploads.available || uploads.cards.length || uploads.busy || uploads.failed) drift('The prepared composer contains unowned or unknown attachments')
      if (generation) this.ensureTranscript(facts, generation)
      this.prepared = { turnId: turn.turnId, url: facts.url, prompt }
    })
  }

  private async createProject(turn: PageTurn, signal: AbortSignal): Promise<BrowserGeneration> {
    let generation = this.generation(turn)!
    await this.mutation(turn, 'project-dialog-open', signal, async () => {
      await (await unique(this.page.locator('nav button,aside button,[data-testid="sidebar"] button').filter({ hasText: /^(New project|新建项目|新项目)$/ }), 'Project creation is unavailable in this layout')).click()
      await poll(async () => await visible(this.page.getByRole('dialog').locator('input[type="text"],input:not([type])')).count() === 1 ? true : undefined, signal)
      return 'creation-dialog-visible'
    }, value => ({ state: value }))
    const dialog = await unique(this.page.getByRole('dialog'), 'The Project creation dialog is unavailable')
    const title = await unique(dialog.locator('input[type="text"],input:not([type])'), 'The Project title field is ambiguous')
    await this.mutation(turn, 'project-title-input', signal, async () => { await title.fill(generation.title); if (await title.inputValue() !== generation.title) drift('The Project title input did not match'); return generation.title }, value => ({ title: value }))
    const memory = await unique(dialog.locator('button,[role="radio"],[role="menuitemradio"]').filter({ hasText: /^(Project[- ]only(?: memory)?|仅限项目|仅项目)$/i }), 'Explicit Project-only creation is unavailable')
    await this.mutation(turn, 'project-memory-selection', signal, async () => {
      await memory.click()
      await poll(async () => (await this.page.evaluate(readProjectEvidence)).projectOnly ? true : undefined, signal)
      return 'project-only'
    }, value => ({ memory: value }))
    const create = await unique(dialog.getByRole('button', { name: /^(Create project|创建项目)$/ }), 'The Create Project action is unavailable')
    await this.mutation(turn, 'project-create', signal, async () => {
      if (await title.inputValue() !== generation.title || !(await this.page.evaluate(readProjectEvidence)).projectOnly) drift('The Project creation settings changed')
      await create.click()
      return poll(async () => { const facts = await this.ready(signal); return projectUrl(facts.url, this.origin) && facts.projectTitle === generation.title ? facts.url : undefined }, signal)
    }, value => ({ projectUrl: value })).then(async url => { await this.ledger.updateGeneration(turn.generationId, { projectUrl: url }) })
    generation = this.generation(turn)!
    await this.verifyProject(generation, signal)
    const facts = await this.facts()
    if (facts.messages.length || facts.composer.text.trim()) drift('A fresh Project must contain a visibly empty first chat')
    return generation
  }

  private async selectPro(turn: PageTurn, signal: AbortSignal): Promise<void> {
    for (const [kind, label] of [['model-selection', 'GPT-6'], ['effort-selection', 'Pro']] as const) {
      for (let attempt = 0; attempt <= 10; attempt++) {
        const current = await inspectModel(this.page, signal)
        if ((kind === 'model-selection' ? current.model : current.effort) === label) break
        if (attempt === 10) drift('The explicit model/effort control did not reach its declared value')
        const choice = await this.modelChoice(label, signal)
        try {
          if (choice.kind === 'option') {
            await this.mutation(turn, kind, signal, async () => {
              await choice.locator.click()
              await poll(async () => {
                const state = await inspectModel(this.page, signal)
                return (kind === 'model-selection' ? state.model : state.effort) === label ? true : undefined
              }, signal)
              return label
            }, value => ({ selected: value }))
          } else {
            const raw = await choice.locator.getAttribute('aria-valuenow')
            const max = await choice.locator.getAttribute('aria-valuemax')
            const number = Number(raw), maximum = Number(max)
            if (raw === null || max === null || !Number.isSafeInteger(number) || !Number.isSafeInteger(maximum)
              || maximum <= number || maximum - number > 10) drift('The reasoning slider has no safe bounded next step')
            await this.mutation(turn, kind, signal, async () => {
              await choice.locator.press('ArrowRight')
              return poll(async () => {
                const value = await choice.locator.getAttribute('aria-valuenow')
                const label = await choice.locator.getAttribute('aria-valuetext')
                return value !== null && Number(value) > number && Number(value) <= maximum && label?.trim() ? { value, label } : undefined
              }, signal)
            }, value => ({ selectedValue: value.value, selectedLabel: value.label }))
          }
        } finally { await dismiss(this.page, true) }
      }
    }
    const after = await inspectModel(this.page, signal)
    if (after.model !== 'GPT-6' || after.effort !== 'Pro') drift('The exact model selection could not be verified')
  }

  private async modelChoice(label: 'GPT-6' | 'Pro', signal: AbortSignal): Promise<{ kind: 'option' | 'slider', locator: Locator }> {
    await dismiss(this.page)
    await (await unique(this.page.locator(MODEL_TRIGGER), 'The model control is unavailable')).click()
    const opened = new Set<string>()
    for (let step = 0; step < 8; step++) {
      check(signal)
      const options = visible(this.page.locator('[role="menu"] [role="radio"],[role="menu"] [role="menuitemradio"],[role="dialog"] [role="radio"]')).filter({ hasText: new RegExp(`^${label}$`) })
      if (await options.count() > 1) drift('The requested model option is ambiguous')
      if (await options.count() === 1) {
        if (!await options.isEnabled()) drift('The requested model option is disabled')
        return { kind: 'option', locator: options }
      }
      if (label === 'Pro') {
        const sliders = visible(this.page.locator('[role="menu"] [data-reasoning-slider] [role="slider"],[role="menu"] [data-model-picker-power-slider] [role="slider"],[role="dialog"] [data-reasoning-slider] [role="slider"]'))
        if (await sliders.count() > 1) drift('The reasoning slider is ambiguous')
        if (await sliders.count() === 1) return { kind: 'slider', locator: sliders }
      }
      const roots = visible(this.page.locator('[role="menu"] [role="menuitem"][aria-haspopup="menu"],[role="menu"] button[aria-haspopup="menu"],button[data-model-picker-advanced]'))
      const desired = roots.filter({ hasText: label === 'GPT-6' ? /^(Model|模型)\s*GPT-[\w.-]+$/i : /^(Effort|思考强度|思考等级|推理强度)(?:\s*.*)?$/i })
      const opener = await desired.count() === 0 ? roots.filter({ hasText: /^(Advanced|高级|高级设置)$/i }) : desired
      if (await opener.count() !== 1) break
      const title = await opener.innerText()
      if (opened.has(title)) break
      opened.add(title); await opener.click()
    }
    drift('An explicit supported model/effort choice is unavailable')
  }

  async submit(turn: PageTurn, originalSignal: AbortSignal): Promise<{ promptId: string }> {
    return this.exclusive(async () => {
      const signal = this.signal(originalSignal)
      const prepared = this.prepared
      if (!prepared || prepared.turnId !== turn.turnId) failure('WEB_BROWSER_PREPARE', 'This exact request has not passed read-only preparation')
      this.admitted(turn)
      if (renderPrompt(turn, this.budget(), this.generation(turn)) !== prepared.prompt) failure('WEB_BROWSER_PREPARE', 'The admitted website projection changed after preparation')
      // Revalidate all same-URL mutable admission facts before any remote input.
      let facts = await this.binding(signal, prepared.url)
      if (facts.composer.text.trim()) drift('The composer changed after preparation')
      await this.ledger.admit(turn, prepared.prompt)
      if (this.ledger.mutations(turn.turnId).length) failure('WEB_BROWSER_UNCERTAIN', 'This browser request already has mutation evidence and is never resubmitted')
      let generation = this.generation(turn)!
      if (this.projectIsolation) {
        if (generation.projectUrl === undefined) generation = await this.createProject(turn, signal)
        else {
          if (facts.url !== generation.conversationUrl) drift('The generation is no longer on its exact conversation')
          this.ensureTranscript(facts, generation)
          await this.verifyProject(generation, signal)
        }
      } else if (generation.conversationUrl !== undefined) {
        if (facts.url !== generation.conversationUrl) drift('The generation is no longer on its exact conversation')
        this.ensureTranscript(facts, generation)
      }
      await this.selectPro(turn, signal)
      const url = this.page.url()
      facts = await this.binding(signal, url)
      this.ensureTranscript(facts, generation)
      if (this.projectIsolation) {
        if (facts.url !== generation.projectUrl && facts.projectUrl !== generation.projectUrl) drift('The composer is outside its owned Project')
      } else if (generation.conversationUrl !== undefined && facts.url !== generation.conversationUrl) {
        drift('The composer left its exact conversation')
      }
      const prompt = prepared.prompt
      const encoded = JSON.parse(prompt) as { request: { attachmentVersions: Array<{ id: string }> } }
      const referenced = new Set(encoded.request.attachmentVersions.map(version => version.id))
      const images = turn.request.attachmentVersions.filter(version => referenced.has(version.id))
      const expectedUploads: string[] = []
      const initialUploads = await this.page.evaluate(readUploads)
      if (!initialUploads.available || initialUploads.cards.length || initialUploads.busy || initialUploads.failed) drift('The composer contains unowned attachments')
      for (const version of images) {
        const buffer = attachmentBytes(version)
        await this.binding(signal, url)
        const composer = await unique(this.page.locator(COMPOSER), 'The composer became ambiguous')
        const input = composer.locator('xpath=ancestor::form[1]').locator('input[type="file"]')
        if (await input.count() !== 1) drift('A unique composer upload input is required')
        expectedUploads.push(version.uploadName)
        await this.mutation(turn, 'image-upload', signal, async () => {
          await input.setInputFiles({ name: version.uploadName, mimeType: version.mimeType, buffer })
          await poll(async () => {
            const state = await this.page.evaluate(readUploads)
            if (state.failed) drift('The image upload failed visibly')
            if (state.cards.some(card => !expectedUploads.includes(card.name))) drift('An unknown attachment appeared during upload')
            return !state.busy && state.cards.every(card => card.ready) && canonical(state.cards.map(card => card.name).sort()) === canonical([...expectedUploads].sort()) ? true : undefined
          }, signal)
          return version.uploadName
        }, name => ({ name, digest: version.digest }))
      }
      facts = await this.binding(signal, url)
      this.ensureTranscript(facts, generation)
      if (facts.composer.text.trim()) drift('The prepared input context changed before text entry')
      if (this.projectIsolation && facts.url !== generation.projectUrl && facts.projectUrl !== generation.projectUrl) drift('The prepared input context changed before text entry')
      if (!this.projectIsolation && generation.conversationUrl !== undefined && facts.url !== generation.conversationUrl) drift('The prepared input context changed before text entry')
      const composer = await unique(this.page.locator(COMPOSER), 'The composer is unavailable')
      await this.mutation(turn, 'prompt-input', signal, async () => {
        await composer.fill(prompt)
        if ((await this.facts()).composer.text.trim() !== prompt.trim()) drift('The website did not preserve the complete exact prompt')
        return textDigest(prompt)
      }, digest => ({ promptDigest: digest }))
      facts = await this.binding(signal, url)
      this.ensureTranscript(facts, generation)
      if (facts.composer.text.trim() !== prompt.trim()) drift('The input context changed before Send')
      if (this.projectIsolation && facts.url !== generation.projectUrl && facts.projectUrl !== generation.projectUrl) drift('The input context changed before Send')
      if (!this.projectIsolation && generation.conversationUrl !== undefined && facts.url !== generation.conversationUrl) drift('The input context changed before Send')
      const uploadState = await this.page.evaluate(readUploads)
      if (uploadState.busy || uploadState.failed || uploadState.cards.some(card => !card.ready)
        || canonical(uploadState.cards.map(card => card.name).sort()) !== canonical([...expectedUploads].sort())) drift('The exact complete image set is not ready at Send')
      const sendSelector = 'button[data-testid="send-button"],button[data-testid="composer-send-button"],button[aria-label="Send"],button[aria-label="Send prompt"],button[aria-label="发送提示"]'
      const form = composer.locator('xpath=ancestor::form[1]')
      const button = await unique(await form.count() === 1 ? form.locator(sendSelector) : this.page.locator(sendSelector),
        'A unique Send control is unavailable')
      const beforeIds = new Set(generation.transcript.map(message => message.id))
      const accepted = await this.mutation(turn, 'send', signal, async () => {
        await button.click()
        return poll(async () => {
          const state = await this.facts()
          const matches = state.messages.filter(message => message.role === 'user' && !beforeIds.has(message.id) && message.text === prompt)
          if (matches.length > 1) drift('The accepted prompt identity is ambiguous')
          if (matches.length !== 1) return undefined
          const match = matches[0]!
          if (!conversationUrl(state.url, this.origin)) return undefined
          if (this.projectIsolation && state.projectUrl !== generation.projectUrl) return undefined
          if (canonical(match.attachments) !== canonical([...expectedUploads].sort())) drift('The accepted prompt has different image evidence')
          return { id: match.id, url: state.url }
        }, signal)
      }, value => ({ promptId: value.id, conversationUrl: value.url }))
      await this.ledger.updateTurn(turn.turnId, { promptId: accepted.id })
      await this.ledger.updateGeneration(turn.generationId, { conversationUrl: accepted.url })
      this.prepared = undefined
      return { promptId: accepted.id }
    })
  }

  private expectedUploads(prompt: string): string[] {
    const envelope = JSON.parse(prompt) as { request: { attachmentVersions: Array<{ uploadName: string }> } }
    return envelope.request.attachmentVersions.map(version => version.uploadName).sort()
  }

  private async completed(turn: PageTurn, promptId: string, signal: AbortSignal): Promise<unknown | undefined> {
    const generation = this.generation(turn)!
    const record = this.ledger.turn(turn.turnId)!
    const state = await this.facts()
    if (state.url !== generation.conversationUrl) drift('The observed response left its exact chat')
    if (this.projectIsolation && state.projectUrl !== generation.projectUrl) drift('The observed response left its exact owned Project')
    if (state.hostedTools || state.error) failure('WEB_BROWSER_PAGE_ERROR', 'The website reports an error or active hosted tool mode')
    const index = state.messages.findIndex(message => message.id === promptId && message.role === 'user' && message.text === record.prompt)
    if (index < 0) drift('The exact accepted prompt is missing from the visible transcript')
    if (canonical(state.messages[index]!.attachments) !== canonical(this.expectedUploads(record.prompt))) drift('The submitted prompt attachment evidence changed')
    if (canonical(transcript({ ...state, messages: state.messages.slice(0, index) }), WEB_MAX_REQUEST_BYTES) !== canonical(generation.transcript, WEB_MAX_REQUEST_BYTES)) drift('The transcript before this prompt changed')
    const after = state.messages.slice(index + 1)
    if (after.some(message => message.role !== 'assistant') || after.length > 1) drift('An unowned turn appeared after the submitted prompt')
    const answer = after[0]
    if (state.active || !answer || !answer.finished || answer.busy) return undefined
    if (this.projectIsolation) await this.verifyProject(generation, signal)
    const finalState = await this.binding(signal, generation.conversationUrl)
    if (this.projectIsolation && finalState.projectUrl !== generation.projectUrl) drift('The terminal response changed its Project binding during final inspection')
    if (canonical(transcript(finalState), WEB_MAX_REQUEST_BYTES) !== canonical(transcript(state), WEB_MAX_REQUEST_BYTES)) drift('The terminal transcript changed while account/model binding was rechecked')
    const finalAnswer = finalState.messages[index + 1]
    if (!finalAnswer?.finished || finalAnswer.busy || finalState.active) return undefined
    const terminalTranscriptDigest = textDigest(canonical(transcript(finalState), WEB_MAX_REQUEST_BYTES))
    if (record.terminalFailure !== undefined) {
      const proof = record.terminalFailure
      if (proof.promptId !== promptId || proof.responseId !== answer.id || proof.responseText !== answer.text
        || proof.responseDigest !== textDigest(answer.text) || proof.transcriptDigest !== terminalTranscriptDigest) {
        drift('The terminally invalid response differs from its immutable recorded evidence')
      }
      check(signal)
      throw new TerminalResponseFailure()
    }
    let response: unknown
    try { response = parseResponse(answer.text, turn) }
    catch (error) {
      // This catch surrounds only deterministic protocol validation. Account,
      // Project, history, DOM, timeout and storage errors never establish a
      // terminal remote outcome or clear its engine fence.
      if (!(error instanceof WebBridgeError) || !['WEB_INVALID_RESPONSE', 'WEB_INVALID_REQUEST', 'WEB_RESPONSE_LIMIT'].includes(error.code)
        || Buffer.byteLength(answer.text, 'utf8') > WEB_MAX_JSON_BYTES) throw error
      check(signal)
      await this.ledger.rejectResponse(turn.turnId, { kind: 'invalid-response', promptId, responseId: answer.id,
        responseText: answer.text, responseDigest: textDigest(answer.text), transcriptDigest: terminalTranscriptDigest })
      check(signal)
      throw new TerminalResponseFailure()
    }
    await this.ledger.complete(turn.turnId, { responseId: answer.id, responseText: answer.text, completed: true }, turn.generationId, { transcript: transcript(state), lastTurnId: turn.turnId,
      projectedMessageCount: turn.request.messages.length, projectedMessagesDigest: textDigest(canonical(turn.request.messages, WEB_MAX_REQUEST_BYTES)),
      projectionSettingsDigest: projectionSettingsDigest(turn) })
    return response
  }

  async observe(turn: PageTurn, promptId: string, originalSignal: AbortSignal): Promise<unknown> {
    return this.exclusive(async () => {
      const signal = this.signal(originalSignal)
      const record = this.ledger.turn(turn.turnId)
      if (!record || record.promptId !== promptId || record.requestHash !== turn.request.idempotencyKey) failure('WEB_BROWSER_HISTORY', 'Observation does not identify the exact submitted request')
      await this.binding(signal, this.generation(turn)?.conversationUrl, true)
      return poll(() => this.completed(turn, promptId, signal), signal, this.options.timeoutMs ?? DEFAULT_RESPONSE_TIMEOUT)
    })
  }

  async recover(turn: PageTurn): Promise<PageRecovery> {
    return this.exclusive(async () => {
      const record = this.ledger.turn(turn.turnId)
      if (!record) return { kind: 'not-submitted' }
      if (record.requestHash !== turn.request.idempotencyKey || record.generationId !== turn.generationId) return { kind: 'unknown' }
      const signal = AbortSignal.timeout(Math.min(this.options.timeoutMs ?? 30_000, 30_000))
      try {
        const generation = this.generation(turn)
        const send = this.ledger.mutations(turn.turnId).find(action => action.kind === 'send')
        // The ledger precedes every Send. Once this exclusive operation starts,
        // the original submit has settled; no Send record proves no submission.
        // Uncertain Project/uploads still retain their separate browser fence.
        if (!send) return { kind: 'not-submitted' }
        if (!generation) return { kind: 'unknown' }
        if (this.projectIsolation ? !generation.projectUrl : !generation.conversationUrl) return { kind: 'unknown' }
        const observedPrompt = send.state === 'observed' ? send.evidence?.promptId : undefined
        const observedUrl = send.state === 'observed' ? send.evidence?.conversationUrl : undefined
        if (send.state === 'observed' && (!observedPrompt || !observedUrl)
          || record.promptId !== undefined && observedPrompt !== undefined && record.promptId !== observedPrompt
          || generation.conversationUrl !== undefined && observedUrl !== undefined && generation.conversationUrl !== observedUrl) return { kind: 'unknown' }
        const knownPrompt = record.promptId ?? observedPrompt
        const knownUrl = generation.conversationUrl ?? observedUrl
        if (knownUrl) await this.navigate(knownUrl, signal)
        let facts = await this.binding(signal, knownUrl, true)
        if (!conversationUrl(facts.url, this.origin)) return { kind: 'unknown' }
        if (this.projectIsolation && facts.projectUrl !== generation.projectUrl) return { kind: 'unknown' }
        const candidateUrl = facts.url
        if (this.projectIsolation) await this.verifyProject({ ...generation, conversationUrl: candidateUrl }, signal)
        facts = await this.binding(signal, candidateUrl, true)
        if (this.projectIsolation && facts.projectUrl !== generation.projectUrl) return { kind: 'unknown' }
        const prompts = facts.messages.filter(message => message.role === 'user' && message.text === record.prompt
          && (knownPrompt === undefined || message.id === knownPrompt)
          && canonical(message.attachments) === canonical(this.expectedUploads(record.prompt))
          && !generation.transcript.some(item => item.id === message.id))
        if (record.completed && record.promptId && record.responseText && record.responseId && generation.lastTurnId === turn.turnId) {
          const answer = facts.messages.find(message => message.id === record.responseId && message.role === 'assistant')
          if (facts.active || !answer?.finished || answer.busy || canonical(transcript(facts), WEB_MAX_REQUEST_BYTES) !== canonical(generation.transcript, WEB_MAX_REQUEST_BYTES)) return { kind: 'unknown' }
          return { kind: 'completed', response: parseResponse(record.responseText, turn) }
        }
        if (prompts.length !== 1) return { kind: 'unknown' }
        if (send.state === 'intent') await this.ledger.observed(send, { promptId: prompts[0]!.id, conversationUrl: facts.url })
        await this.ledger.updateTurn(turn.turnId, { promptId: prompts[0]!.id })
        await this.ledger.updateGeneration(turn.generationId, { conversationUrl: facts.url })
        const response = await this.completed(turn, prompts[0]!.id, signal)
        return response === undefined ? { kind: 'unknown' } : { kind: 'completed', response }
      } catch (error) {
        return error instanceof TerminalResponseFailure ? { kind: 'terminal-failure', message: error.message } : { kind: 'unknown' }
      }
    })
  }

  async discard(turn: PageTurn): Promise<void> {
    return this.exclusive(async () => {
      await this.ledger.discard(turn)
      if (this.prepared?.turnId === turn.turnId) this.prepared = undefined
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    if (this.busy) failure('WEB_BROWSER_BUSY', 'Stop the engine operation before disconnecting its browser transport')
    this.closed = true
    try { await this.ledger.close() } finally { if (this.options.attached !== true) await this.browser.close() }
  }
}

export async function createChromePageTransport(options: ChromePageTransportOptions): Promise<ChromePageTransport> {
  if (!Number.isSafeInteger(options.maxInputBytes ?? DEFAULT_INPUT_BYTES) || (options.maxInputBytes ?? DEFAULT_INPUT_BYTES) < 1024
    || (options.maxInputBytes ?? DEFAULT_INPUT_BYTES) > 16 * 1024 * 1024) failure('WEB_BROWSER_SETUP', 'The website input budget must be a bounded byte count')
  const connection = await connect(options)
  try {
    const ledger = await BrowserLedger.open(options.stateDirectory, { profileDirectory: options.expectedProfileDirectory,
      provider: options.provider, profileId: options.profileId, accountBinding: options.expectedAccountBinding }, options.initialize === true, options.testOnlyLedgerFault)
    return new Transport(options, connection.browser, connection.page, connection.origin, ledger)
  } catch (error) { if (options.attached !== true) await connection.browser.close(); throw error }
}
