/** Resolve a real input in the owned composer, including the site's general file picker. */
export function composerImageInput(): HTMLInputElement {
  const composer = document.querySelector<HTMLElement>('#prompt-textarea,form[data-chatgpt-composer] [contenteditable="true"][role="textbox"],textarea[name="prompt-textarea"]')
  const root = composer?.closest('form')
  if (!root) throw new Error('Composer upload scope is unavailable')
  const inputs = [...root.querySelectorAll<HTMLInputElement>('input[type="file"]')].filter(input => {
    if (input.disabled) return false
    const accept = (input.getAttribute('accept') ?? '').trim().toLowerCase()
    return !accept || accept.split(',').some(value => value.trim().startsWith('image/') || ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(value.trim()))
  })
  if (inputs.length !== 1) throw new Error('Composer image upload input is ambiguous')
  return inputs[0]!
}

/** This self-contained function is executed verbatim in the browser and DOM fixtures. */
export function imageUploadEvidence(messageId?: string): {
  scopeReady: boolean
  cards: Array<{ name: string; ready: boolean; failed: boolean }>
  busy: boolean
  error: boolean
  messageText?: string
} {
  const visible = (node: Element): boolean => node.getClientRects().length > 0 && node.getAttribute('aria-hidden') !== 'true'
  const composer = document.querySelector<HTMLElement>('#prompt-textarea,form[data-chatgpt-composer] [contenteditable="true"][role="textbox"],textarea[name="prompt-textarea"]')
  const message = messageId === undefined ? undefined : [...document.querySelectorAll<HTMLElement>('[data-message-author-role="user"][data-message-id]')].find(node => node.getAttribute('data-message-id') === messageId)
  const root = messageId === undefined ? composer?.closest('form') : message?.closest('article[data-turn],article[data-turn-key],[data-testid^="conversation-turn"]') ?? message
  if (!root) return { scopeReady: false, cards: [], busy: false, error: false }
  const selector = '[data-testid="file-upload"],[data-testid="file-card"],[data-testid="attachment"],[data-testid^="attachment-thumbnail"],[data-testid="file-thumbnail"],[data-file-id][data-filename],[data-file-id][data-file-name],[data-composer-attachments] [class~="group/composer-attachment"]'
  const nodes = [...root.querySelectorAll<HTMLElement>(selector)].filter(visible)
  // Prefer the enclosing tile when a thumbnail has its own test id.
  const cards = nodes.filter(node => !nodes.some(other => other !== node && other.contains(node)))
  for (const image of root.querySelectorAll<HTMLImageElement>('img')) {
    if (!visible(image) || cards.some(card => card.contains(image))) continue
    // Sent images may be standalone links. Avatars and unrelated controls are
    // not attachments; generated upload names provide the exact association.
    if (/^dsh-[a-f0-9]{20}-[a-f0-9]{20}\.(?:png|jpg|webp|gif)$/.test(image.alt)) cards.push(image.closest('a') ?? image)
  }
  const projected = cards.map(card => {
    const values = [card.getAttribute('data-filename'), card.getAttribute('data-file-name'), card.getAttribute('title'),
      ...[...card.querySelectorAll<HTMLElement>('[data-filename],[data-file-name],[data-testid="file-name"],[title],img[alt],button[aria-label]')].flatMap(node => [node.getAttribute('data-filename'), node.getAttribute('data-file-name'), node.getAttribute('title'), node.getAttribute('alt'), node.getAttribute('aria-label'), node.textContent])]
    if (card instanceof HTMLImageElement) values.push(card.alt)
    const names = new Set(values.flatMap(value => value?.match(/\bdsh-[a-f0-9]{20}-[a-f0-9]{20}\.(?:png|jpg|webp|gif)\b/g) ?? []))
    const statuses = [card, ...card.querySelectorAll<HTMLElement>('[data-upload-status],[data-upload-state],[role="status"]')]
    const failed = statuses.some(node => /^(failed|error)$/i.test(node.getAttribute('data-upload-status') ?? node.getAttribute('data-upload-state') ?? '') || /^(Upload failed|Failed to upload|上传失败)$/i.test(node.textContent?.trim() ?? ''))
    const busy = Boolean(card.querySelector('[role="progressbar"],[aria-busy="true"]')) || card.getAttribute('aria-busy') === 'true' || statuses.some(node => /^(uploading|pending|loading|processing)$/i.test(node.getAttribute('data-upload-status') ?? node.getAttribute('data-upload-state') ?? ''))
    const completed = statuses.some(node => /^(complete|completed|ready|uploaded)$/i.test(node.getAttribute('data-upload-status') ?? node.getAttribute('data-upload-state') ?? '') || /^(Upload complete|Upload completed|已上传|上传完成)$/i.test(node.textContent?.trim() ?? ''))
    // A local image preview, an enabled Send button, or a vanished spinner alone
    // does not prove completion. A server file id may be allocated before any
    // bytes arrive. The composer must expose a positive completion fact; the
    // resulting user message must then retain the same exact attachment.
    const ready = !failed && !busy && (completed || (messageId !== undefined && (card instanceof HTMLImageElement || Boolean(card.querySelector('img')))))
    return { name: names.size === 1 ? [...names][0]! : '', ready, failed }
  })
  const busy = [...root.querySelectorAll('[role="progressbar"],[data-upload-status="uploading"],[data-upload-state="uploading"]')].some(visible)
  const error = [...root.querySelectorAll<HTMLElement>('[role="alert"],[data-testid="upload-error"]')].some(node => visible(node) && /upload|file|image|上传|附件|图片/i.test(node.innerText ?? node.textContent ?? '')) || projected.some(card => card.failed)
  let messageText: string | undefined
  if (message) {
    const body = message.querySelector<HTMLElement>('[data-message-content],.whitespace-pre-wrap,.markdown') ?? message
    // Clone only the user message text. The original DOM remains untouched.
    const clone = body.cloneNode(true) as HTMLElement
    for (const tile of clone.querySelectorAll(selector)) tile.remove()
    for (const image of clone.querySelectorAll('img')) image.remove()
    messageText = clone.innerText ?? clone.textContent ?? ''
  }
  return { scopeReady: true, cards: projected, busy, error, ...(messageText === undefined ? {} : { messageText }) }
}
