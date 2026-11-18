import { CdpPage, openBrowser } from './cdp.ts'
import { checkDeadline, digest, wait } from './storage.ts'
import { join } from 'node:path'
import { assertAcceptedWebMedia, readWebMediaArtifact, validateWebMedia } from '../media.ts'
import { imageUploadEvidence } from './media-dom.ts'
import type { WebConnection, WebConversation, WebEvidence, WebPage, WebPageFactory, WebPageSample, WebTurnRequest } from './types.ts'

// Layout reference: steipete/oracle 0a064e7b, modelSelection/thinkingTime/constants.
// This adapter is independently implemented. Unknown layout or locale fails before submit.
const MODEL_TRIGGER = 'button[aria-label="Select ChatGPT model"],button[data-codex-intelligence-trigger="true"],form[data-chatgpt-composer] button[data-composer-navigation-target="reasoning"],[data-testid="model-switcher-dropdown-button"]'
const COMPOSER = '#prompt-textarea,form[data-chatgpt-composer] [contenteditable="true"][role="textbox"],textarea[name="prompt-textarea"]'

/** Self-contained page function: fixtures run the same DOM code as production. */
export function modelSelectionAction(action: 'open' | 'select' | 'verify', trigger: string, observedModel = false): { ready: boolean; model?: string; effort?: string } {
  const visible = (element: Element): boolean => element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true'
  if (action === 'open') {
    const button = [...document.querySelectorAll<HTMLElement>(trigger)].find(visible)
    if (!button) return { ready: false }
    if (button.getAttribute('aria-expanded') !== 'true') button.click()
    return { ready: true }
  }
  const menus = [...document.querySelectorAll<HTMLElement>('[role="menu"],[role="dialog"],[data-radix-menu-content]')].filter(visible)
  const all = menus.flatMap((menu) => [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"],[role="radio"]')]).filter(visible)
  const model = all.find((node) => node.textContent?.trim() === 'GPT-6')
  const checkedWrongModel = all.some((node) => /^GPT-/.test(node.textContent?.trim() ?? '') && node.getAttribute('aria-checked') === 'true' && node.textContent?.trim() !== 'GPT-6')
  if (checkedWrongModel || (model && model.getAttribute('aria-checked') !== 'true')) {
    if (action === 'select' && model) model.click()
    return { ready: false, model: 'mismatch' }
  }
  const openers = menus.flatMap((menu) => [...menu.querySelectorAll<HTMLElement>('[role="menuitem"][aria-haspopup="menu"],button[aria-haspopup="menu"],button[data-model-picker-advanced]')]).filter(visible)
  if (observedModel && openers.some((node) => /^(Model|模型)\s*GPT-/i.test(node.textContent?.trim() ?? '') && !/^(Model|模型)\s*GPT-6$/i.test(node.textContent?.trim() ?? ''))) return { ready: false, model: 'mismatch' }
  if (!model && !observedModel) {
    const opener = openers.find((node) => /^(Model|模型)\s*GPT-/i.test(node.textContent?.trim() ?? '')) ??
      openers.find((node) => /^(Advanced|高级|高级设置)$/i.test(node.textContent?.trim() ?? ''))
    // Opening a submenu is observation; verify mode never changes a checked value.
    opener?.click()
    return { ready: false }
  }
  const pro = all.find((node) => node.textContent?.trim() === 'Pro')
  if (pro) {
    if (pro.getAttribute('aria-checked') === 'true') return { ready: true, model: 'GPT-6', effort: 'Pro' }
    if (action === 'select') pro.click()
    return { ready: false, model: 'GPT-6' }
  }
  const slider = menus.flatMap((menu) => [...menu.querySelectorAll<HTMLElement>('[data-reasoning-slider] [role="slider"],[data-model-picker-power-slider] [role="slider"]')]).find(visible)
  if (!slider) {
    const effort = openers.find((node) => /^(Effort|思考强度|思考等级|推理强度)(?:\s|Pro|High|Medium|Instant|Extra|高|中|低)/.test(node.textContent?.trim() ?? ''))
    effort?.click()
    return { ready: false, model: 'GPT-6' }
  }
  const described = (slider.getAttribute('aria-describedby') ?? '').split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
  const valueText = slider.getAttribute('aria-valuetext') ?? described
  if (/^Pro(?:\s*[,，]|\s*$)/.test(valueText.trim())) return { ready: true, model: 'GPT-6', effort: 'Pro' }
  // A number alone is not evidence of Pro. Move only within an observed bounded control,
  // and require the accessible value/announcement to spell out Pro afterwards.
  const current = Number(slider.getAttribute('aria-valuenow'))
  const maximum = Number(slider.getAttribute('aria-valuemax'))
  if (action === 'select' && Number.isFinite(current) && Number.isFinite(maximum) && maximum - current > 0 && maximum - current <= 10) {
    slider.focus()
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }))
    slider.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }))
  }
  return { ready: false, model: 'GPT-6' }
}

export function snapshotPage(): {
  url: string; projectUrl: string | null; messages: Array<{ role: string; id: string; text: string; finished: boolean; thinking: boolean }>
  stopVisible: boolean; thinkingVisible: boolean; activeTools: boolean; phase: string; composerReady: boolean; errorText: string
} {
  const visible = (element: Element): boolean => element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true'
  const messages: Array<{ role: string; id: string; text: string; finished: boolean; thinking: boolean }> = []
  const seen = new Set<string>()
  for (const node of document.querySelectorAll<HTMLElement>('[data-message-author-role][data-message-id]')) {
    const id = node.getAttribute('data-message-id') ?? ''
    const role = node.getAttribute('data-message-author-role') ?? ''
    if (!id || !['assistant', 'user'].includes(role) || seen.has(id)) continue
    seen.add(id)
    const turn = node.closest('[data-testid^="conversation-turn"],article[data-turn],article[data-turn-key]') ?? node
    const body = node.querySelector<HTMLElement>('.markdown,[data-message-content]') ?? node
    const stop = [...turn.querySelectorAll('[aria-busy="true"],[data-is-streaming="true"],[data-testid="thinking-indicator"],[role="progressbar"]')].some(visible)
    const finished = [...turn.querySelectorAll('button[data-testid="copy-turn-action-button"],.turn-action-controls button[aria-label="Copy"],.turn-action-controls button[aria-label="复制"],.turn-action-controls button[aria-label="コピーする"]')].some(visible)
    messages.push({ role, id, text: body.innerText, finished, thinking: stop })
  }
  const stopVisible = [...document.querySelectorAll('[data-testid="stop-button"],[data-testid="composer-stop-button"]')].some(visible)
  const thinkingVisible = [...document.querySelectorAll('[data-testid="thinking-indicator"],[data-thinking-status="active"],[data-is-streaming="true"]')].some(visible)
  const activeTools = [...document.querySelectorAll('form [data-testid*="connector"][data-state="active"],form [data-testid*="app"][aria-pressed="true"],form [data-testid*="agent-mode"][aria-pressed="true"]')].some(visible)
  const status = [...document.querySelectorAll<HTMLElement>('form[data-chatgpt-composer] [role="status"],[data-testid="thinking-indicator"]')].filter(visible).map((node) => node.innerText.trim()).join(' ')
  // Error evidence comes from UI alert controls outside the answer, never from answer prose.
  const alerts = [...document.querySelectorAll<HTMLElement>('[role="alert"],[data-testid="conversation-error"]')].filter((node) => visible(node) && !node.closest('[data-message-author-role]')).map((node) => node.innerText).join(' ')
  const project = [...document.querySelectorAll<HTMLAnchorElement>('header a[href],nav a[aria-current="page"][href]')].find((node) => /\/g\/g-p-[a-zA-Z0-9-]+\/project$/.test(node.getAttribute('href') ?? ''))
  return { url: location.href, projectUrl: project?.href ?? null, messages, stopVisible, thinkingVisible, activeTools, phase: status.slice(0,256), composerReady: Boolean(document.querySelector('#prompt-textarea,form[data-chatgpt-composer] [contenteditable="true"][role="textbox"]')), errorText: alerts.slice(0,2048) }
}

/** Read only controls in the project settings dialog, never model-generated text. */
export function projectSettingsEvidence(): { projectOnly: boolean; emptyInstructions: boolean } {
  const visible = (node: Element): boolean => node.getClientRects().length > 0 && !node.closest('[hidden],[aria-hidden="true"]')
  const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"],[data-testid="project-settings"]')].find(visible)
  if (!dialog) return { projectOnly: false, emptyInstructions: false }
  const mode = (node: HTMLElement): 'project-only' | 'default' | undefined => {
    const text = (node.innerText ?? node.textContent ?? '').trim()
    if (/^(Project[- ]only(?: memory)?|仅限项目(?:记忆)?|仅项目(?:记忆)?)$/i.test(text)) return 'project-only'
    if (/^(Default(?: memory)?|默认(?:记忆)?)$/i.test(text)) return 'default'
    return undefined
  }
  const controlSelector = '[role="radio"],[role="menuitemradio"],option,[aria-checked],[data-state="checked"],[data-state="unchecked"]'
  const controls = [...dialog.querySelectorAll<HTMLElement>(controlSelector)].filter(visible).filter(node =>
    node.matches('[role="radio"],[role="menuitemradio"],option') || mode(node) !== undefined)
  let contradictory = false
  const selected = controls.filter(node => {
    const states: boolean[] = []
    const checked = node.getAttribute('aria-checked')
    if (checked !== null) {
      if (checked !== 'true' && checked !== 'false') contradictory = true
      states.push(checked === 'true')
    }
    const state = node.getAttribute('data-state')
    if (state === 'checked' || state === 'unchecked') states.push(state === 'checked')
    if (node.tagName === 'OPTION') states.push((node as HTMLOptionElement).selected ?? node.hasAttribute('selected'))
    if (states.some(Boolean) && states.some(value => !value)) contradictory = true
    return states.length > 0 && states.every(Boolean)
  })
  // Only a dedicated current-mode field is a readonly fact. Labels inside
  // unselected options and generic explanatory prose never establish memory.
  const readonlyModes = [...dialog.querySelectorAll<HTMLElement>('[data-testid="project-memory-mode"],[data-project-memory]')]
    .filter(node => visible(node) && !node.closest(controlSelector)).map(mode)
  const readonlyConsistent = readonlyModes.every(value => value === 'project-only')
  const projectOnly = !contradictory && readonlyConsistent && (controls.length > 0
    ? selected.length === 1 && mode(selected[0]!) === 'project-only'
    : readonlyModes.length > 0)
  const instructions = [...dialog.querySelectorAll<HTMLTextAreaElement>('textarea[name="instructions"],textarea[aria-label="Instructions"],textarea[aria-label="指令"],[data-testid="project-instructions"]')].filter(visible)
  const emptyInstructions = instructions.length > 0 && instructions.every(node => !(node.value ?? node.innerText ?? node.textContent ?? '').trim())
  return { projectOnly, emptyInstructions }
}

export function projectSourcesEvidence(): boolean {
  const visible = (node: Element): boolean => node.getClientRects().length > 0 && !node.closest('[hidden],[aria-hidden="true"]')
  const root = document.querySelector<HTMLElement>('[data-testid="project-page"],main')
  if (!root || !visible(root)) return false
  if (root.querySelector('[data-testid="project-file"],[data-testid="project-source"],[data-project-file-id],[data-project-source-id]')) return false
  const counts = [...root.querySelectorAll<HTMLElement>('[data-testid="project-sources-count"]')].filter(visible)
  // A present count is authoritative, including a nonzero or loading value.
  // An empty-state placeholder must not override it during UI transitions.
  if (counts.length) return counts.every(node => (node.innerText ?? node.textContent ?? '').trim() === '0')
  return [...root.querySelectorAll<HTMLElement>('p,span,[role="status"]')].some(node => visible(node) && /^(No (?:files|sources)(?: added)?(?: yet)?|尚无(?:文件|来源)|暂无(?:文件|来源)|未添加(?:文件|来源))$/i.test(node.innerText?.trim() ?? ''))
}

export function projectSharingEvidence(): boolean {
  const visible = (node: Element): boolean => node.getClientRects().length > 0 && !node.closest('[hidden],[aria-hidden="true"]')
  const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(visible)
  if (!dialog) return false
  const collaborators = [...dialog.querySelectorAll('[data-testid="project-member"],[data-project-member-id]')].filter((node) => node.getAttribute('data-role') !== 'owner')
  const sharedLink = dialog.querySelector('[data-testid="project-public-link"],[data-sharing="anyone-with-link"]')
  if (collaborators.length || sharedLink) return false
  const privateMode = (node: HTMLElement): boolean => /^(Only you|Private|仅自己|仅你|私有)$/i.test((node.innerText ?? node.textContent ?? '').trim())
  const controlSelector = '[role="radio"],[role="menuitemradio"],option,[aria-checked],[data-state="checked"],[data-state="unchecked"]'
  const controls = [...dialog.querySelectorAll<HTMLElement>(controlSelector)].filter(visible)
  let contradictory = false
  const selected = controls.filter(node => {
    const states: boolean[] = []
    const checked = node.getAttribute('aria-checked')
    if (checked !== null) {
      if (checked !== 'true' && checked !== 'false') contradictory = true
      states.push(checked === 'true')
    }
    const state = node.getAttribute('data-state')
    if (state === 'checked' || state === 'unchecked') states.push(state === 'checked')
    if (node.tagName === 'OPTION') states.push((node as HTMLOptionElement).selected ?? node.hasAttribute('selected'))
    if (states.some(Boolean) && states.some(value => !value)) contradictory = true
    return states.length > 0 && states.every(Boolean)
  })
  const readonlyModes = [...dialog.querySelectorAll<HTMLElement>('[data-testid="project-sharing-mode"]')]
    .filter(node => visible(node) && !node.closest(controlSelector))
  if (contradictory || readonlyModes.some(node => !privateMode(node))) return false
  return controls.length > 0 ? selected.length === 1 && privateMode(selected[0]!) : readonlyModes.length > 0
}

export function conversationFromUrl(url: string, projectUrl?: string, title?: string): WebConversation {
  const parsed = new URL(url)
  if (parsed.origin !== 'https://chatgpt.com' || parsed.search || parsed.hash) throw new Error('ChatGPT navigation escaped the bound origin')
  const match = parsed.pathname.match(/\/(?:c|project)\/([a-zA-Z0-9-]+)$/) ?? parsed.pathname.match(/^\/g\/(g-p-[a-zA-Z0-9-]+)\/project$/)
  // A newly-created container has no conversation ID until first prompt acceptance.
  const id = match?.[1] ?? (parsed.pathname === '/' ? 'new' : parsed.pathname)
  return { id, url: parsed.href, ...(projectUrl ? { projectUrl } : {}), ...(title ? { title } : {}) }
}

function uiError(text: string): WebPageSample['error'] {
  if (!text) return undefined
  if (/context.{0,20}(?:long|limit|full)|conversation.{0,20}(?:long|limit)|上下文.{0,10}(?:上限|过长)|对话.{0,10}过长/i.test(text)) return { code: 'CONTEXT_WINDOW_EXCEEDED', reason: 'web-context-limit' }
  if (/usage limit|weekly limit|daily limit|额度|用量上限/i.test(text)) return { code: 'QUOTA', reason: 'web-quota' }
  if (/too many requests|rate limit|try again later|请求过于频繁/i.test(text)) return { code: 'RATE_LIMIT', reason: 'web-rate-limit' }
  if (/sign in|log in|登录/i.test(text)) return { code: 'AUTH', reason: 'web-login-required' }
  return { code: 'SERVER', reason: 'web-ui-error' }
}

export class ChatGptPage implements WebPage {
  readonly targetId: string
  private projectUrl: string | undefined
  private title: string | undefined
  private baselineIds = new Set<string>()
  private prompt: string | undefined
  private boundConversationUrl: string | undefined
  private preparedConversationUrl: string | undefined
  private cleanupUntil: number | undefined
  private readonly page: CdpPage
  private readonly connection: WebConnection
  private readonly request: WebTurnRequest
  constructor(page: CdpPage, connection: WebConnection, request: WebTurnRequest) {
    this.page = page; this.connection = connection; this.request = request; this.targetId = page.targetId
  }

  private async evaluate<T>(fn: Function, ...args: unknown[]): Promise<T> {
    if (this.cleanupUntil) checkDeadline(this.cleanupUntil)
    else checkDeadline(this.request.deadlineMs, this.request.signal)
    return this.page.evaluate<T>(`(${fn.toString()})(${args.map((arg) => JSON.stringify(arg)).join(',')})`)
  }
  private async ready(): Promise<void> {
    const deadline = Math.min(this.request.deadlineMs, Date.now() + 15_000)
    for (;;) {
      if (await this.page.evaluate<boolean>(`document.readyState === 'complete' && Boolean(document.querySelector(${JSON.stringify(COMPOSER)}))`)) return
      await wait(150, deadline, this.request.signal)
    }
  }
  private async account(): Promise<string> {
    const opened = await this.page.evaluate<boolean>(`(() => { const b = document.querySelector('[data-testid="accounts-profile-button"],[data-testid="profile-button"]'); if (!b) return false; b.click(); return true; })()`)
    if (!opened) throw new Error('Account menu is unavailable; sign in using the dedicated browser profile')
    let email: string | undefined
    const deadline = Math.min(this.request.deadlineMs, Date.now() + 5_000)
    try {
      for (;;) {
        const emails = await this.page.evaluate<string[]>(`(() => { const found = new Set(); for (const n of document.querySelectorAll('[role="menu"],[role="dialog"]')) { if (!n.getClientRects().length) continue; for (const m of (n.innerText || '').matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/gi)) found.add(m[0].toLowerCase()); } return [...found]; })()`)
        if (emails.length === 1) { email = emails[0]; break }
        if (emails.length > 1) throw new Error('Account menu identity is ambiguous')
        await wait(100, deadline, this.request.signal)
      }
    } finally { await this.page.escape() }
    if (!email) throw new Error('Account identity could not be observed')
    return digest(email)
  }
  async observeAccountFingerprint(): Promise<string> { await this.ready(); return this.account() }
  private async selectModel(mutate: boolean): Promise<void> {
    const deadline = Math.min(this.request.deadlineMs, Date.now() + 8_000)
    let observedModel = false
    await this.evaluate(modelSelectionAction, 'open', MODEL_TRIGGER)
    try {
      for (;;) {
        const value = await this.evaluate<{ ready: boolean; model?: string; effort?: string }>(modelSelectionAction, mutate ? 'select' : 'verify', MODEL_TRIGGER, observedModel)
        if (value.ready && value.model === 'GPT-6' && value.effort === 'Pro') return
        if (value.model === 'GPT-6') observedModel = true
        else if (value.model === 'mismatch') observedModel = false
        await wait(100, deadline, this.request.signal)
        // Some model choices close the menu; reopen it before verifying both controls.
        await this.evaluate(modelSelectionAction, 'open', MODEL_TRIGGER)
      }
    } finally { await this.page.escape() }
  }

  private async createProject(beforeContainerMutation?: () => Promise<void>): Promise<void> {
    const opened = await this.page.evaluate<boolean>(`(() => { const list = [...document.querySelectorAll('nav button,aside button,[data-testid="sidebar"] button')]; const b = list.find(n => /^(New project|新建项目|新项目)$/.test((n.innerText || n.getAttribute('aria-label') || '').trim())); if (!b) return false; b.click(); return true; })()`)
    if (!opened) throw new Error('Managed project creation is unavailable in this layout')
    const title = this.request.title.trim().slice(0,100) || `DSH ${this.request.sessionId.slice(0,12)}`
    const filled = await this.page.evaluate<boolean>(`(() => { const d = [...document.querySelectorAll('[role="dialog"]')].find(n=>n.getClientRects().length); const i = d?.querySelector('input[type="text"],input:not([type])'); if (!i) return false; i.focus(); return true; })()`)
    if (!filled) throw new Error('Project creation dialog is unavailable')
    await this.page.insertText(title)
    const selected = await this.page.evaluate<boolean>(`(() => { const d = [...document.querySelectorAll('[role="dialog"]')].find(n=>n.getClientRects().length); if (!d) return false; const p = [...d.querySelectorAll('button,[role="radio"],[role="menuitemradio"]')].find(n=>/^(Project-only|Project only|仅限项目|仅项目)$/i.test((n.innerText || n.getAttribute('aria-label') || '').trim())); if (!p) return false; p.click(); return true; })()`)
    if (!selected) throw new Error('Project-only memory cannot be explicitly selected; managed mode is unavailable')
    await wait(150, this.request.deadlineMs, this.request.signal)
    const creation = (click: boolean): string => `(() => { const d = [...document.querySelectorAll('[role="dialog"]')].find(n=>n.getClientRects().length); if (!d) return false; const i=d.querySelector('input[type="text"],input:not([type])'); if(!i||i.value!==${JSON.stringify(title)}) return false; const p = [...d.querySelectorAll('[aria-checked="true"],[data-state="checked"],option:checked')].find(n=>/^(Project-only|Project only|仅限项目|仅项目)$/i.test((n.innerText || n.getAttribute('aria-label') || '').trim())); if (!p) return false; const b = [...d.querySelectorAll('button')].find(n=>/^(Create project|创建项目)$/.test((n.innerText||'').trim())); if (!b || b.disabled) return false; ${click ? 'b.click();' : ''} return true; })()`
    if (!await this.page.evaluate<boolean>(creation(false))) throw new Error('Project-only selection or project creation could not be verified')
    // Opening and inspecting the dialog creates no hosted container. Publish
    // the intent immediately before the actual Create action, after admission.
    await beforeContainerMutation?.()
    checkDeadline(this.request.deadlineMs, this.request.signal)
    const created = await this.page.evaluate<boolean>(creation(true))
    if (!created) throw new Error('Project-only selection or project creation could not be verified')
    const deadline = Math.min(this.request.deadlineMs, Date.now() + 10_000)
    for (;;) {
      const url = await this.page.evaluate<string>('location.href')
      if (/^https:\/\/chatgpt\.com\/g\/g-p-[a-zA-Z0-9-]+\/project$/.test(url)) { this.projectUrl = url; break }
      await wait(150, deadline, this.request.signal)
    }
  }

  private async verifyContext(): Promise<void> {
    const facts = await this.evaluate<ReturnType<typeof snapshotPage>>(snapshotPage)
    if (facts.activeTools) throw new Error('Hosted apps or agent mode must be disabled for the local tool bridge')
    if (this.request.contextPolicy === 'personalized') return
    const current = await this.page.evaluate<string>('location.href')
    if (!this.projectUrl || (current !== this.projectUrl && facts.projectUrl !== this.projectUrl)) throw new Error('Conversation project ownership could not be verified')
    const returnUrl = current
    if (current !== this.projectUrl) { await this.page.navigate(this.projectUrl); await this.ready() }
    try {
      if (!await this.evaluate<boolean>(projectSourcesEvidence)) throw new Error('Managed project sources are not observably empty')
      const menu = await this.page.evaluate<boolean>(`(() => { const b=document.querySelector('button[data-testid="project-menu-button"],button[aria-label="Open project menu"],button[aria-label="打开项目菜单"]'); if (!b) return false; b.click(); return true; })()`)
      if (!menu) throw new Error('Project settings menu is unavailable')
      await wait(100, this.request.deadlineMs, this.request.signal)
      const settings = await this.page.evaluate<boolean>(`(() => { const b=[...document.querySelectorAll('[role="menu"] [role="menuitem"],[role="menu"] button')].find(n=>/^(Project settings|项目设置)$/.test((n.innerText||'').trim())); if (!b) return false; b.click(); return true; })()`)
      if (!settings) throw new Error('Project settings are unavailable in this layout')
      await wait(100, this.request.deadlineMs, this.request.signal)
      const configuration = await this.evaluate<ReturnType<typeof projectSettingsEvidence>>(projectSettingsEvidence)
      await this.page.escape()
      if (!configuration.projectOnly || !configuration.emptyInstructions) throw new Error('Managed project must show project-only memory and no unbound instructions')
      const sharing = await this.page.evaluate<boolean>(`(() => { const b=[...document.querySelectorAll('header button,[data-testid="project-page"] button')].find(n=>/^(Share|Share project|共享|分享项目)$/.test((n.innerText||n.getAttribute('aria-label')||'').trim())); if (!b) return false; b.click(); return true; })()`)
      if (!sharing) throw new Error('Project sharing settings are unavailable')
      await wait(100, this.request.deadlineMs, this.request.signal)
      const privateProject = await this.evaluate<boolean>(projectSharingEvidence)
      await this.page.escape()
      if (!privateProject) throw new Error('Managed project must be private with no collaborators or shared link')
    } finally {
      await this.page.escape()
      if (returnUrl !== this.projectUrl) { await this.page.navigate(returnUrl); await this.ready() }
    }
  }

  async prepare(request: WebTurnRequest, beforeContainerMutation?: () => Promise<void>): Promise<{ conversation: WebConversation; evidence: WebEvidence }> {
    if (request.conversation) { this.projectUrl = request.conversation.projectUrl; this.title = request.conversation.title; this.boundConversationUrl=request.conversation.url;await this.page.navigate(request.conversation.url) }
    else { await this.page.navigate('https://chatgpt.com/') }
    await this.ready()
    const account = await this.account()
    if (account !== this.connection.accountFingerprint) throw new Error('Signed-in account does not match the configured connection')
    if (!request.conversation && request.contextPolicy === 'project-only') { await this.createProject(beforeContainerMutation); await this.ready() }
    await this.verifyContext()
    await this.selectModel(true)
    const snapshot = await this.evaluate<ReturnType<typeof snapshotPage>>(snapshotPage)
    const expectedUrl = request.conversation?.url ?? this.projectUrl ?? 'https://chatgpt.com/'
    if (snapshot.url !== expectedUrl) throw new Error('Owned conversation changed during preparation')
    if (snapshot.stopVisible || snapshot.thinkingVisible || snapshot.messages.some((message) => message.thinking)) throw new Error('Conversation already has an active generation')
    this.baselineIds = new Set(snapshot.messages.map((message) => message.id))
    const conversation = conversationFromUrl(snapshot.url, this.projectUrl, this.title)
    // A new chat has no durable /c/... URL yet, but its prepared composer is
    // already owned. Freeze that page until Send; sample() binds the new URL
    // only after the exact submitted user message is observed there.
    this.preparedConversationUrl = conversation.url
    return { conversation, evidence: this.evidence(conversation.url, account) }
  }
  async inspect(request: WebTurnRequest): Promise<{ conversation: WebConversation; evidence: WebEvidence }> {
    if (!request.conversation) throw new Error('Read-only recovery requires the original conversation')
    this.projectUrl = request.conversation.projectUrl; this.title = request.conversation.title
    const current = await this.page.evaluate<string>('location.href')
    const wasNew=request.conversation.id==='new'||request.conversation.url===request.conversation.projectUrl
    if (current !== request.conversation.url && !(wasNew&&/^https:\/\/chatgpt\.com\/(?:g\/g-p-[a-zA-Z0-9-]+\/)?c\/[a-zA-Z0-9-]+$/.test(current))) throw new Error('Owned browser tab moved; recovery will not navigate or alter it')
    await this.ready()
    const account = await this.account()
    if (account !== this.connection.accountFingerprint) throw new Error('Recovery account does not match the original call')
    await this.verifyContext(); await this.selectModel(false)
    this.prompt = request.prompt
    this.boundConversationUrl=current
    return { conversation: conversationFromUrl(current,this.projectUrl,this.title), evidence: this.evidence(current, account) }
  }
  private evidence(url: string, accountFingerprint: string): WebEvidence {
    return { adapter: 'chatgpt-dom/1', model: 'GPT-6', effort: 'Pro', accountFingerprint, contextPolicy: this.request.contextPolicy, conversationUrl: url, ...(this.projectUrl ? { projectUrl: this.projectUrl } : {}), capturedAt: Date.now(), bindingDigest: this.request.bindingDigest }
  }
  private async verifySubmissionIdentity(expectedUrl: string): Promise<void> {
    checkDeadline(this.request.deadlineMs, this.request.signal)
    if (await this.account() !== this.connection.accountFingerprint) throw new Error('Signed-in account changed before submission')
    // Preparation may precede persisted submit-intent or a lengthy upload.
    // Observe the same model and effort again; never silently change them.
    await this.selectModel(false)
    const snapshot = await this.evaluate<ReturnType<typeof snapshotPage>>(snapshotPage)
    if (snapshot.activeTools) throw new Error('Hosted apps or agent mode must be disabled before submission')
    if (snapshot.url !== expectedUrl || snapshot.stopVisible || snapshot.thinkingVisible || snapshot.messages.some(message => message.thinking)
      || (this.request.contextPolicy === 'project-only' && snapshot.url !== this.projectUrl && snapshot.projectUrl !== this.projectUrl)) throw new Error('Conversation ownership changed before submission')
  }
  async submit(prompt: string): Promise<void> {
    checkDeadline(this.request.deadlineMs, this.request.signal)
    const media = this.request.media ?? []
    validateWebMedia(this.request.media)
    const before = await this.evaluate<ReturnType<typeof imageUploadEvidence>>(imageUploadEvidence)
    if (before.cards.length || before.busy || before.error) throw new Error('Composer contains unexpected or unresolved attachments')
    const expectedUrl = await this.page.evaluate<string>('location.href')
    if (new URL(expectedUrl).origin !== 'https://chatgpt.com' || expectedUrl !== this.preparedConversationUrl || (this.boundConversationUrl && expectedUrl !== this.boundConversationUrl)) throw new Error('Owned conversation changed before upload')
    // Both text and image content must stay local until the prepared account,
    // model, effort and idle conversation have been re-observed.
    await this.verifySubmissionIdentity(expectedUrl)
    const focused = await this.page.evaluate<boolean>(`(() => { const e = document.querySelector(${JSON.stringify(COMPOSER)}); if (!e || (e.innerText || e.value || '').trim()) return false; e.focus(); return true; })()`)
    if (!focused) throw new Error('Composer is unavailable or contains unexpected unsent content')
    if (media.length) {
      if (!before.scopeReady) throw new Error('The supported composer attachment scope is unavailable')
      for (const item of media) await readWebMediaArtifact(item, join(this.connection.stateDir, 'images'))
      checkDeadline(this.request.deadlineMs, this.request.signal)
      await this.page.setFileInputFiles(media.map(item => item.artifact.path), expectedUrl)
      const uploadDeadline = Math.min(this.request.deadlineMs, Date.now() + 60_000)
      let confirmations = 0
      for (;;) {
        checkDeadline(uploadDeadline, this.request.signal)
        if (await this.page.evaluate<string>('location.href') !== expectedUrl) throw new Error('Owned conversation changed during image upload')
        const uploaded = await this.evaluate<ReturnType<typeof imageUploadEvidence>>(imageUploadEvidence)
        if (!uploaded.scopeReady || uploaded.error || uploaded.cards.some(card => card.failed)) throw new Error('Image upload failed or its composer scope disappeared')
        const names = uploaded.cards.map(card => card.name)
        if (uploaded.cards.length > media.length || names.some(name => name && !media.some(item => item.uploadName === name))) throw new Error('Composer received an unexpected image attachment')
        const complete = !uploaded.busy && uploaded.cards.length === media.length && uploaded.cards.every(card => card.ready && card.name)
        if (complete) { assertAcceptedWebMedia(media, names); if (++confirmations >= 2) break }
        else confirmations = 0
        await wait(150, uploadDeadline, this.request.signal)
      }
      // Recheck the bound account/model after a potentially long upload without
      // navigating away from the composer or recreating a hosted project.
      await this.verifySubmissionIdentity(expectedUrl)
      for (const item of media) await readWebMediaArtifact(item, join(this.connection.stateDir, 'images'))
      const refocused = await this.page.evaluate<boolean>(`(() => { const e = document.querySelector(${JSON.stringify(COMPOSER)}); if (!e || (e.innerText || e.value || '').trim()) return false; e.focus(); return true; })()`)
      if (!refocused) throw new Error('Composer changed during image upload')
    }
    await this.page.insertText(prompt)
    const correct = await this.page.evaluate<boolean>(`(() => { const e=document.querySelector(${JSON.stringify(COMPOSER)}); return (e?.value ?? e?.innerText ?? '').replace(/\\r\\n/g,'\\n') === ${JSON.stringify(prompt.replace(/\r\n/g,'\n'))}; })()`)
    if (!correct) throw new Error('Composer did not preserve the full request')
    checkDeadline(this.request.deadlineMs, this.request.signal)
    const submitted = await this.page.evaluate<boolean>(`(() => { if(location.href!==${JSON.stringify(expectedUrl)})return false; const uploads=(${imageUploadEvidence.toString()})(); const expected=${JSON.stringify(media.map(item => item.uploadName).sort())}; if(uploads.busy||uploads.error||uploads.cards.some(n=>!n.ready)||JSON.stringify(uploads.cards.map(n=>n.name).sort())!==JSON.stringify(expected))return false; const e=document.querySelector(${JSON.stringify(COMPOSER)}); if((e?.value??e?.innerText??'').replace(/\\r\\n/g,'\\n')!==${JSON.stringify(prompt.replace(/\r\n/g,'\n'))})return false; const b=(e?.closest('form')??document).querySelector('button[data-testid="send-button"],button[data-testid="composer-send-button"]'); if (!b || b.disabled || b.getAttribute('aria-disabled')==='true') return false; b.click(); return true; })()`)
    if (!submitted) throw new Error('Submit control is unavailable')
    this.prompt = prompt
  }
  async sample(): Promise<WebPageSample> {
    const snapshot = await this.evaluate<ReturnType<typeof snapshotPage>>(snapshotPage)
    if (this.request.contextPolicy === 'project-only' && snapshot.url !== this.projectUrl && snapshot.projectUrl !== this.projectUrl) throw new Error('Owned conversation moved outside its bound project')
    if (this.boundConversationUrl && snapshot.url !== this.boundConversationUrl) throw new Error('Owned conversation URL changed during the invocation')
    const media = this.request.media ?? []
    const userMedia = new Map<string, ReturnType<typeof imageUploadEvidence>>()
    for (const message of snapshot.messages.filter(message => message.role === 'user' && !this.baselineIds.has(message.id))) {
      const observed = await this.evaluate<ReturnType<typeof imageUploadEvidence>>(imageUploadEvidence, message.id)
      userMedia.set(message.id, observed)
      if (observed.messageText !== undefined && (media.length || observed.cards.length)) message.text = observed.messageText
    }
    const users = snapshot.messages.filter((message) => message.role === 'user' && !this.baselineIds.has(message.id) && message.text.replace(/\r\n/g,'\n').trim() === this.prompt?.replace(/\r\n/g,'\n').trim())
    if (users.length > 1) throw new Error('Prompt appears more than once in the original conversation')
    // New chats obtain their durable URL asynchronously. Wait for that identity
    // before confirming dispatch, otherwise a crash could bind to a project page.
    const user = /\/c\/[a-zA-Z0-9-]+$/.test(new URL(snapshot.url).pathname) ? users[0] : undefined
    let acceptedMedia: string[] | undefined
    if (user) {
      const observed = userMedia.get(user.id)
      if (!observed?.scopeReady || observed.busy || observed.error || observed.cards.some(card => !card.ready)) throw new Error('Accepted user message has unresolved image attachments')
      acceptedMedia = observed.cards.map(card => card.name)
      assertAcceptedWebMedia(this.request.media, acceptedMedia)
    }
    if(user&&!this.boundConversationUrl)this.boundConversationUrl=snapshot.url
    const userIndex = user ? snapshot.messages.indexOf(user) : -1
    const following = userIndex < 0 ? [] : snapshot.messages.slice(userIndex + 1)
    if (following.some((message) => message.role === 'user')) throw new Error('Conversation received another user turn during the owned invocation')
    const assistants = following.filter((message) => message.role === 'assistant')
    const answer = assistants.at(-1)
    const error = uiError(snapshot.errorText)
    return {
      conversation: conversationFromUrl(snapshot.url, this.projectUrl, this.title),
      ...(user ? { userMessageId: user.id, acceptedPrompt: user.text } : {}),
      ...(acceptedMedia?.length ? { acceptedMedia } : {}),
      ...(answer ? { responseId: answer.id } : {}), text: assistants.map((message) => message.text).join('\n'),
      stopVisible: snapshot.stopVisible, thinking: snapshot.thinkingVisible || following.some((message) => message.thinking),
      finishedActions: Boolean(answer?.finished), ...(snapshot.phase ? { phase: snapshot.phase } : {}), ...(error ? { error } : {}),
    }
  }
  async stop(userMessageId: string): Promise<boolean> {
    this.cleanupUntil = Date.now() + 2_000
    this.page.cdp.beginCleanup()
    const sample = await this.sample()
    if (sample.userMessageId !== userMessageId) return false
    // A single apparent finished frame is not the debounced terminal proof used
    // by capture. Cancellation cannot promote that weaker observation to cloud
    // cleanup confirmation.
    const clicked = await this.page.evaluate<boolean>(`(() => { const b=document.querySelector('[data-testid="stop-button"],[data-testid="composer-stop-button"]'); if(!b || !b.getClientRects().length) return false; b.click(); return true; })()`)
    // A clicked stop button is intent, not cloud termination proof.
    if (!clicked) return false
    return false
  }
  async finalize(conversation: WebConversation): Promise<WebConversation> {
    checkDeadline(this.request.deadlineMs,this.request.signal)
    const oldTitle=await this.page.evaluate<string | null>(`(() => { const a=[...document.querySelectorAll('nav a[href],aside a[href],[data-testid="sidebar"] a[href]')].find(n=>n.href===${JSON.stringify(conversation.url)}); return a?.innerText?.trim()||null; })()`)
    if(!oldTitle)return conversation
    // Preserve meaningful platform or user titles. Rename only known placeholders;
    // naming is a UI operation and never spends another Pro model call.
    if(!/^(New chat|新聊天|新对话|ChatGPT|Session(?:\s+[-_a-f0-9]{8,})?)$/i.test(oldTitle))return {...conversation,title:oldTitle}
    const title=this.request.title.trim().slice(0,100)
    if(!title)return conversation
    const opened=await this.page.evaluate<boolean>(`(() => { const a=[...document.querySelectorAll('nav a[href],aside a[href],[data-testid="sidebar"] a[href]')].find(n=>n.href===${JSON.stringify(conversation.url)}); if(!a || a.innerText.trim()!==${JSON.stringify(oldTitle)})return false; const row=a.closest('[data-testid="history-item"],[data-sidebar-item],li'); const b=row?.querySelector('button[data-testid="history-item-options"],button[aria-label="Open conversation options"],button[aria-label="打开对话选项"]'); if(!b)return false;b.click();return true;})()`)
    if(!opened)return {...conversation,title:oldTitle}
    try {
      await wait(100,this.request.deadlineMs,this.request.signal)
      const rename=await this.page.evaluate<boolean>(`(() => {const b=[...document.querySelectorAll('[role="menu"] [role="menuitem"],[role="menu"] button')].find(n=>/^(Rename|重命名)$/.test((n.innerText||'').trim()));if(!b)return false;b.click();return true;})()`)
      if(!rename)return {...conversation,title:oldTitle}
      await wait(100,this.request.deadlineMs,this.request.signal)
      const selected=await this.page.evaluate<boolean>(`(() => { const d=[...document.querySelectorAll('[role="dialog"]')].find(n=>n.getClientRects().length);const i=d?.querySelector('input[type="text"],input:not([type])');if(!i||i.value!==${JSON.stringify(oldTitle)})return false;i.focus();i.select();return true;})()`)
      if(!selected)return {...conversation,title:oldTitle}
      await this.page.insertText(title)
      const saved=await this.page.evaluate<boolean>(`(() => {const d=[...document.querySelectorAll('[role="dialog"]')].find(n=>n.getClientRects().length);const i=d?.querySelector('input[type="text"],input:not([type])');if(!i||i.value!==${JSON.stringify(title)})return false;const b=[...d.querySelectorAll('button')].find(n=>/^(Save|保存)$/.test((n.innerText||'').trim()));if(!b||b.disabled)return false;b.click();return true;})()`)
      if(!saved)return {...conversation,title:oldTitle}
      await wait(100,this.request.deadlineMs,this.request.signal)
      const confirmed=await this.page.evaluate<boolean>(`[...document.querySelectorAll('nav a[href],aside a[href],[data-testid="sidebar"] a[href]')].some(n=>n.href===${JSON.stringify(conversation.url)} && n.innerText.trim()===${JSON.stringify(title)})`)
      return {...conversation,title:confirmed?title:oldTitle}
    }finally{await this.page.escape()}
  }
  async close(): Promise<void> { await this.page.close() }
}

export class CdpWebPageFactory implements WebPageFactory {
  async open(connection: WebConnection, request: WebTurnRequest, targetId?: string): Promise<WebPage> {
    checkDeadline(request.deadlineMs, request.signal)
    const cdp = await openBrowser(connection, request.deadlineMs,request.signal)
    try {
      checkDeadline(request.deadlineMs, request.signal)
      const page = await CdpPage.create(cdp, targetId)
      if (request.signal?.aborted) { await page.close(); checkDeadline(request.deadlineMs, request.signal) }
      return new ChatGptPage(page, connection, request)
    } catch (error) { cdp.close(); throw error }
  }
  async connect(connection: WebConnection, deadlineMs: number): Promise<{ accountFingerprint?: string; targetId: string }> {
    const cdp = await openBrowser(connection, deadlineMs)
    try {
      const page = await CdpPage.create(cdp)
      await page.navigate('https://chatgpt.com/')
      await cdp.command('Target.activateTarget',{targetId:page.targetId})
      // Explicit connection opens a login surface, without prompts or project creation.
      const targetId = page.targetId
      let accountFingerprint: string | undefined
      const probe: WebTurnRequest = {
        requestId: 'connection-check', executionDomainId: 'connection-check', sessionId: 'connection-check',
        generation: 0, bindingDigest: digest(`connection:${connection.id}`), prompt: '', title: '',
        deadlineMs: Math.min(deadlineMs,Date.now()+1_500), contextPolicy: 'personalized', maxPromptBytes: 1,maxResponseBytes:1,
      }
      try { accountFingerprint = await new ChatGptPage(page,connection,probe).observeAccountFingerprint() } catch { /* Sign-in may still require the user. */ }
      await page.close()
      return { targetId, ...(accountFingerprint ? {accountFingerprint} : {}) }
    } catch (error) { cdp.close(); throw error }
  }
}
