/** Versioned visible-UI evidence readers, executed unchanged inside Chromium. */
export const COMPOSER = '#prompt-textarea,form[data-chatgpt-composer] [contenteditable="true"][role="textbox"],textarea[name="prompt-textarea"]'
export const PROFILE_TRIGGER = '[data-testid="accounts-profile-button"],[data-testid="profile-button"]'
export const MODEL_TRIGGER = 'button[aria-label="Select ChatGPT model"],button[data-codex-intelligence-trigger="true"],form[data-chatgpt-composer] button[data-composer-navigation-target="reasoning"],[data-testid="model-switcher-dropdown-button"]'

export interface PageMessageEvidence { id: string, role: string, text: string, finished: boolean, busy: boolean, attachments: string[], unknownAttachments: boolean }
export interface PageEvidence {
  url: string
  accountIdentities: string[]
  model: string | null
  effort: string | null
  ambiguousSelection: boolean
  composer: { count: number, text: string, ready: boolean }
  projectUrl: string | null
  projectTitle: string | null
  messages: PageMessageEvidence[]
  ambiguousMessages: boolean
  active: boolean
  hostedTools: boolean
  error: string
}

/** No network, application stores, cookie access, or hidden page API is used here. */
export function readPageEvidence(): PageEvidence {
  const visible = (node: Element): boolean => node.getClientRects().length > 0 && !node.closest('[hidden],[aria-hidden="true"]')
  const outsideMessages = (node: Element): boolean => !node.closest('[data-message-author-role]')
  const text = (node: Element): string => ((node as HTMLElement).innerText ?? node.textContent ?? '').trim()
  const all = (selector: string, root: ParentNode = document): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(selector)].filter(visible)
  const menus = all('[role="menu"],[role="dialog"],[data-radix-menu-content]').filter(outsideMessages)
  const accountRoots = menus.filter(menu => menu.matches('[data-testid="account-menu"],[data-testid="profile-menu"]')
    || all('[role="menuitem"],button,a', menu).some(item => /^(Log out|Sign out|注销|退出登录)$/i.test(text(item))))
  const identities = new Set<string>()
  for (const root of accountRoots) {
    // Whole-menu innerText can join an inline email and an adjacent action:
    // <span>owner@example.test</span><button>Log out</button> becomes a false
    // "owner@example.testLog" address. Only accept a complete visible address
    // within one text node; never invent an identity across element boundaries.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const parent = node.parentElement
      if (!parent || !visible(parent) || !outsideMessages(parent)) continue
      for (const match of (node.textContent ?? '').matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) identities.add(match[0].toLowerCase())
    }
  }
  const controls = menus.flatMap(menu => all('[role="menuitemradio"],[role="radio"]', menu))
  const contradictorySelection = controls.filter(node => /^(?:GPT-[\w.-]+|Pro|High|Medium|Low|Instant|Extra High)$/i.test(text(node))).some(node => {
    const aria = node.getAttribute('aria-checked'), state = node.getAttribute('data-state')
    return aria !== null && !['true', 'false'].includes(aria)
      || aria !== null && (state === 'checked' || state === 'unchecked') && (aria === 'true') !== (state === 'checked')
  })
  const choices = controls
    .filter(node => node.getAttribute('aria-checked') === 'true' && node.getAttribute('data-state') !== 'unchecked')
  const models = new Set(choices.map(text).filter(value => /^GPT-[\w.-]+$/i.test(value)))
  const efforts = new Set(choices.map(text).filter(value => /^(Pro|High|Medium|Low|Instant|Extra High)$/i.test(value)))
  for (const slider of menus.flatMap(menu => all('[data-reasoning-slider] [role="slider"],[data-model-picker-power-slider] [role="slider"]', menu))) {
    const value = slider.getAttribute('aria-valuetext')?.trim()
    if (value && /^(Pro|High|Medium|Low|Instant)(?:\s*[,，].*)?$/i.test(value)) efforts.add(value.split(/[,，]/)[0]!.trim())
  }
  // Current-value buttons are evidence only when both exact values are explicit.
  for (const trigger of all('button[aria-label="Select ChatGPT model"],button[data-codex-intelligence-trigger="true"],[data-testid="model-switcher-dropdown-button"]').filter(outsideMessages)) {
    const label = text(trigger).replace(/\s+/g, ' ')
    const current = /^(?:ChatGPT\s+)?(GPT-[\w.-]+)\s+(Pro|High|Medium|Low|Instant|Extra High)$/.exec(label)
    if (current) { models.add(current[1]!); efforts.add(current[2]!) }
  }
  const composers = all('#prompt-textarea,form[data-chatgpt-composer] [contenteditable="true"][role="textbox"],textarea[name="prompt-textarea"]')
  const composer = composers[0]
  const currentText = composer instanceof HTMLTextAreaElement ? composer.value : composer?.innerText ?? ''
  const messages: PageMessageEvidence[] = []
  const seen = new Set<string>()
  let ambiguousMessages = false
  for (const node of all('[data-message-author-role][data-message-id]')) {
    const id = node.getAttribute('data-message-id') ?? ''
    const role = node.getAttribute('data-message-author-role') ?? ''
    if (!id || !['user', 'assistant'].includes(role) || seen.has(id)) { ambiguousMessages = true; continue }
    seen.add(id)
    const turn = node.closest('[data-testid^="conversation-turn"],article[data-turn],article[data-turn-key]') ?? node
    const body = node.querySelector<HTMLElement>('[data-message-content],.markdown,.whitespace-pre-wrap') ?? node
    const clone = body.cloneNode(true) as HTMLElement
    for (const attachment of clone.querySelectorAll('[data-testid="file-upload"],[data-testid="file-card"],[data-testid="attachment"],[data-testid^="attachment-thumbnail"],[data-testid="file-thumbnail"],[data-file-id],img')) attachment.remove()
    const names = new Set<string>()
    for (const attachment of all('[data-filename],[data-file-name],img[alt],[data-testid="file-name"]', turn)) {
      for (const value of [attachment.getAttribute('data-filename'), attachment.getAttribute('data-file-name'), attachment.getAttribute('alt'), text(attachment)]) {
        for (const match of value?.matchAll(/\bdsh-[a-f0-9]{64}\.(?:png|jpg|webp|gif)\b/g) ?? []) names.add(match[0])
      }
    }
    const attachmentNodes = all('[data-testid="file-upload"],[data-testid="file-card"],[data-testid="attachment"],[data-testid^="attachment-thumbnail"],[data-testid="file-thumbnail"],[data-file-id],[data-filename],[data-file-name],img', node)
    const attachmentRoots = attachmentNodes.filter(candidate => !attachmentNodes.some(other => other !== candidate && other.contains(candidate)))
    const rootNames: string[] = []
    for (const root of attachmentRoots) {
      const values = [text(root), ...[root, ...root.querySelectorAll<HTMLElement>('[data-filename],[data-file-name],[alt],[title]')]
        .flatMap(item => [item.getAttribute('data-filename'), item.getAttribute('data-file-name'), item.getAttribute('alt'), item.getAttribute('title')])]
      const found = new Set(values.flatMap(value => [...value?.matchAll(/\bdsh-[a-f0-9]{64}\.(?:png|jpg|webp|gif)\b/g) ?? []].map(match => match[0])))
      rootNames.push(found.size === 1 ? [...found][0]! : '')
    }
    const plain = body.querySelector('[data-testid="file-upload"],[data-testid="file-card"],[data-testid="attachment"],img')
      ? clone.textContent ?? '' : body.innerText ?? body.textContent ?? ''
    messages.push({ id, role, text: plain.replace(/\r\n/g, '\n').trim(),
      busy: all('[aria-busy="true"],[data-is-streaming="true"],[data-testid="thinking-indicator"],[role="progressbar"]', turn).length > 0,
      finished: all('button[data-testid="copy-turn-action-button"],.turn-action-controls button[aria-label="Copy"],.turn-action-controls button[aria-label="复制"]', turn).length > 0,
      attachments: [...names].sort(), unknownAttachments: rootNames.includes('') || new Set(rootNames).size !== rootNames.length })
  }
  const projectLinks = all('header a[href],nav a[aria-current="page"][href]').filter(outsideMessages).filter(node => /\/g\/g-p-[a-zA-Z0-9-]+\/project$/.test(node.getAttribute('href') ?? '')) as HTMLAnchorElement[]
  const projectUrls = [...new Set(projectLinks.map(node => node.href))]
  const projectTitle = all('[data-testid="project-title"],main h1').find(outsideMessages)
  const alerts = all('[role="alert"],[data-testid="conversation-error"]').filter(outsideMessages).map(text).join('\n')
  const ambiguousSelection = contradictorySelection || models.size > 1 || efforts.size > 1
  return {
    url: location.href, accountIdentities: [...identities], model: !ambiguousSelection && models.size === 1 ? [...models][0]! : null,
    effort: !ambiguousSelection && efforts.size === 1 ? [...efforts][0]! : null, ambiguousSelection,
    composer: { count: composers.length, text: currentText.replace(/\r\n/g, '\n'), ready: Boolean(composer) && !composer?.matches('[disabled],[aria-disabled="true"]') },
    projectUrl: projectUrls.length === 1 ? projectUrls[0]! : null,
    projectTitle: projectTitle ? text(projectTitle) : null,
    messages, ambiguousMessages,
    active: all('[data-testid="stop-button"],[data-testid="composer-stop-button"],[data-testid="thinking-indicator"],[data-thinking-status="active"],[data-is-streaming="true"]').some(outsideMessages)
      || messages.some(message => message.busy),
    hostedTools: all('form [data-testid*="connector"][data-state="active"],form [data-testid*="app"][aria-pressed="true"],form [data-testid*="agent-mode"][aria-pressed="true"],form [data-testid*="agent-mode"][data-state="active"],form [data-testid*="deep-research"][aria-pressed="true"]').length > 0,
    error: alerts.slice(0, 2048),
  }
}

export interface ProjectEvidence { projectOnly: boolean, emptyInstructions: boolean, private: boolean, emptySources: boolean, chats: string[] }
export function readProjectEvidence(): ProjectEvidence {
  const visible = (node: Element): boolean => node.getClientRects().length > 0 && !node.closest('[hidden],[aria-hidden="true"],[data-message-author-role]')
  const text = (node: Element): string => ((node as HTMLElement).innerText ?? node.textContent ?? '').trim()
  const all = (selector: string, root: ParentNode = document): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(selector)].filter(visible)
  const dialogs = all('[role="dialog"],[data-testid="project-settings"]')
  const controlSelector = '[role="radio"],[role="menuitemradio"],option,[aria-checked],[data-state="checked"],[data-state="unchecked"]'
  const selected = (accepted: RegExp, currentSelector: string, known: RegExp): boolean => {
    const controls = [...new Set(dialogs.flatMap(root => all(controlSelector, root)))].filter(node =>
      node.matches('[role="radio"],[role="menuitemradio"],option') || known.test(text(node)))
    let contradictory = false
    const values = controls.filter(node => {
      const states: boolean[] = []
      const checked = node.getAttribute('aria-checked')
      if (checked !== null) { if (!['true', 'false'].includes(checked)) contradictory = true; states.push(checked === 'true') }
      const state = node.getAttribute('data-state')
      if (state === 'checked' || state === 'unchecked') states.push(state === 'checked')
      if (node instanceof HTMLOptionElement) states.push(node.selected)
      if (states.some(Boolean) && states.some(value => !value)) contradictory = true
      return states.length > 0 && states.every(Boolean)
    })
    const readonlyModes = dialogs.flatMap(root => all(currentSelector, root)).filter(node => !node.closest(controlSelector))
    return !contradictory && readonlyModes.every(node => accepted.test(text(node)))
      && (controls.length > 0 ? values.length === 1 && accepted.test(text(values[0]!)) : readonlyModes.length > 0)
  }
  const projectOnly = selected(/^(Project[- ]only(?: memory)?|仅限项目(?:记忆)?|仅项目(?:记忆)?)$/i,
    '[data-testid="project-memory-mode"],[data-project-memory]', /^(Project[- ]only(?: memory)?|Default(?: memory)?|仅限项目(?:记忆)?|仅项目(?:记忆)?|默认(?:记忆)?)$/i)
  const instructions = dialogs.flatMap(root => all('textarea[name="instructions"],textarea[aria-label="Instructions"],textarea[aria-label="指令"],[data-testid="project-instructions"]', root))
  const emptyInstructions = instructions.length > 0 && instructions.every(node => !(node instanceof HTMLTextAreaElement ? node.value : text(node)).trim())
  const privateMode = selected(/^(Only you|Private|仅自己|仅你|私有)$/i,
    '[data-testid="project-sharing-mode"]', /^(Only you|Private|Anyone with (?:the )?link|仅自己|仅你|私有|任何持有链接的人)$/i)
  const collaborators = dialogs.flatMap(root => all('[data-testid="project-member"],[data-project-member-id]', root)).filter(node => node.getAttribute('data-role') !== 'owner')
  const publicLinks = dialogs.flatMap(root => all('[data-testid="project-public-link"],[data-sharing="anyone-with-link"]', root))
  const main = document.querySelector<HTMLElement>('[data-testid="project-page"],main')
  const counts = main ? all('[data-testid="project-sources-count"]', main) : []
  const hasFiles = main ? all('[data-testid="project-file"],[data-testid="project-source"],[data-project-file-id],[data-project-source-id]', main).length > 0 : true
  const empty = main && (counts.length > 0 ? counts.every(node => text(node) === '0')
    : all('p,span,[role="status"]', main).some(node => /^(No (?:files|sources)(?: added)?(?: yet)?|尚无(?:文件|来源)|暂无(?:文件|来源)|未添加(?:文件|来源))$/i.test(text(node))))
  const chats = main ? all('a[href]', main).filter(node => /\/c\/[a-zA-Z0-9-]+$/.test(node.getAttribute('href') ?? '')).map(node => (node as HTMLAnchorElement).href) : []
  return { projectOnly, emptyInstructions, private: privateMode && !collaborators.length && !publicLinks.length,
    emptySources: Boolean(empty) && !hasFiles, chats }
}

export interface UploadEvidence { available: boolean, busy: boolean, failed: boolean, cards: Array<{ name: string, ready: boolean }> }
export function readUploads(): UploadEvidence {
  const visible = (node: Element): boolean => node.getClientRects().length > 0 && !node.closest('[hidden],[aria-hidden="true"]')
  const composer = document.querySelector<HTMLElement>('#prompt-textarea,form[data-chatgpt-composer] [contenteditable="true"][role="textbox"],textarea[name="prompt-textarea"]')
  const form = composer?.closest('form')
  if (!form) return { available: false, busy: false, failed: false, cards: [] }
  const nodes = [...form.querySelectorAll<HTMLElement>('[data-testid="file-upload"],[data-testid="file-card"],[data-testid="attachment"],[data-testid^="attachment-thumbnail"],[data-testid="file-thumbnail"],[data-file-id][data-filename],[data-file-id][data-file-name],[data-composer-attachments] [class~="group/composer-attachment"]')].filter(visible)
  const roots = nodes.filter(node => !nodes.some(other => other !== node && other.contains(node)))
  let busy = [...form.querySelectorAll('[role="progressbar"],[aria-busy="true"]')].some(visible)
  let failed = [...form.querySelectorAll('[data-testid="upload-error"],[role="alert"]')].some(visible)
  const cards = roots.map(root => {
    const names = new Set<string>()
    const elements = [root, ...root.querySelectorAll<HTMLElement>('[data-filename],[data-file-name],[title],img[alt],[data-testid="file-name"]')]
    for (const element of elements) for (const text of [element.getAttribute('data-filename'), element.getAttribute('data-file-name'), element.getAttribute('title'), element.getAttribute('alt'), element.textContent]) {
      for (const match of text?.matchAll(/\bdsh-[a-f0-9]{64}\.(?:png|jpg|webp|gif)\b/g) ?? []) names.add(match[0])
    }
    const statuses = [root, ...root.querySelectorAll<HTMLElement>('[data-upload-status],[data-upload-state],[role="status"]')]
    const loading = statuses.some(node => /^(uploading|pending|loading|processing)$/i.test(node.getAttribute('data-upload-status') ?? node.getAttribute('data-upload-state') ?? ''))
      || root.matches('[aria-busy="true"]') || Boolean(root.querySelector('[role="progressbar"],[aria-busy="true"]'))
    const error = statuses.some(node => /^(failed|error)$/i.test(node.getAttribute('data-upload-status') ?? node.getAttribute('data-upload-state') ?? '') || /^(Upload failed|Failed to upload|上传失败)$/i.test(node.textContent?.trim() ?? ''))
    const complete = statuses.some(node => /^(complete|completed|ready|uploaded)$/i.test(node.getAttribute('data-upload-status') ?? node.getAttribute('data-upload-state') ?? '')
      || /^(Upload complete|Upload completed|已上传|上传完成)$/i.test(node.textContent?.trim() ?? ''))
    busy ||= loading; failed ||= error
    return { name: names.size === 1 ? [...names][0]! : '', ready: complete && !loading && !error }
  })
  return { available: true, busy, failed, cards }
}
