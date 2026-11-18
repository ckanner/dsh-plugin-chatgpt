import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { parseHTML } from 'linkedom'
import { ChatGptPage, modelSelectionAction, snapshotPage, projectSettingsEvidence, projectSharingEvidence, projectSourcesEvidence } from '../src/web/browser/page.ts'
import type { CdpPage } from '../src/web/browser/cdp.ts'
import type { WebConnection, WebTurnRequest } from '../src/web/browser/types.ts'
import { digest } from '../src/web/browser/storage.ts'

function dom(html: string) {
  const { document, window } = parseHTML(`<html><body>${html}</body></html>`)
  Object.defineProperty(window.HTMLElement.prototype, 'getClientRects', { configurable: true, value(this: HTMLElement) { return this.style?.display === 'none' || this.hidden ? [] : [{}] } })
  const KeyboardEvent = class extends window.Event {
    key: string; code: string
    constructor(type: string, options: { key: string; code: string; bubbles: boolean }) { super(type, options); this.key = options.key; this.code = options.code }
  }
  const location = { href: 'https://chatgpt.com/' }
  const globals = { document, location, KeyboardEvent, Event: window.Event, HTMLElement: window.HTMLElement, setTimeout, clearTimeout }
  const evaluate = <T>(expression: string): T => runInNewContext(expression, globals) as T
  const call = <T>(fn: Function, ...args: unknown[]): T => evaluate(`(${fn.toString()})(${args.map((value) => JSON.stringify(value)).join(',')})`)
  return { document, window, location, call, evaluate }
}

test('DOM fixture verifies GPT-6 and Pro independently, including announced slider values', () => {
  const f = dom('<div role="menu"><button role="menuitemradio" aria-checked="true">Pro</button></div>')
  assert.equal(f.call<{ready:boolean}>(modelSelectionAction, 'verify', 'button').ready, false)
  f.document.body.innerHTML = '<div role="menu"><button role="menuitemradio" aria-checked="true">GPT-6</button><div data-reasoning-slider><div role="slider" aria-valuenow="4" aria-valuemax="4" aria-describedby="announcement">Slider</div></div></div><span id="announcement">Pro, 5 of 5.</span>'
  assert.equal(f.call<{ready:boolean}>(modelSelectionAction, 'verify', 'button').ready, true)
  f.document.getElementById('announcement')!.textContent = ''
  assert.equal(f.call<{ready:boolean}>(modelSelectionAction, 'verify', 'button').ready, false)
  f.document.body.innerHTML = '<div role="menu"><button role="menuitemradio" aria-checked="true">GPT-5.6 Sol</button><button role="menuitemradio" aria-checked="true">Pro</button></div>'
  assert.equal(f.call<{ready:boolean}>(modelSelectionAction, 'verify', 'button').ready, false)
})

test('DOM fixture reads message-scoped completion and keeps quoted errors out of UI error classification', () => {
  const f = dom('<article data-testid="conversation-turn-1"><div data-message-author-role="user" data-message-id="u1">prompt</div></article><article data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="a1"><div class="markdown">answer<pre><button aria-label="Copy">Copy code</button></pre><div role="alert">Rate limit quoted in answer</div></div></div></article><div data-testid="thinking-indicator">Thinking</div>')
  let value = f.call<ReturnType<typeof snapshotPage>>(snapshotPage)
  assert.equal(value.messages[1]?.finished, false); assert.equal(value.thinkingVisible, true); assert.equal(value.errorText, '')
  const copy = f.document.createElement('button'); copy.setAttribute('data-testid', 'copy-turn-action-button'); copy.textContent = 'Copy'
  f.document.querySelector('[data-testid="conversation-turn-2"]')!.append(copy)
  f.document.querySelector('[data-testid="thinking-indicator"]')!.remove()
  value = f.call<ReturnType<typeof snapshotPage>>(snapshotPage)
  assert.equal(value.messages[1]?.finished, true); assert.equal(value.thinkingVisible, false)
})

test('DOM fixtures require actual private project settings, empty sources and bound instructions', () => {
  const f = dom('<main><h1>Private project-only project</h1></main><div role="dialog"><span>Default memory</span><textarea name="instructions"></textarea></div>')
  assert.equal(f.call<ReturnType<typeof projectSettingsEvidence>>(projectSettingsEvidence).projectOnly, false)
  assert.equal(f.call(projectSourcesEvidence), false)
  f.document.body.innerHTML = '<main><p>No files added yet</p></main><div role="dialog"><button role="radio" aria-checked="true">Project-only</button><textarea name="instructions"></textarea><span data-testid="project-sharing-mode">Only you</span></div>'
  assert.equal(f.call<ReturnType<typeof projectSettingsEvidence>>(projectSettingsEvidence).projectOnly, true)
  assert.equal(f.call(projectSourcesEvidence), true)
  f.document.querySelector('[role="dialog"]')!.innerHTML = '<span data-testid="project-sharing-mode">Only you</span>'
  assert.equal(f.call(projectSharingEvidence), true)
  const member = f.document.createElement('span'); member.setAttribute('data-testid', 'project-member'); member.setAttribute('data-role', 'member')
  f.document.querySelector('[role="dialog"]')!.append(member)
  assert.equal(f.call(projectSharingEvidence), false)
})

test('project memory evidence rejects unselected, hidden and contradictory mode labels', () => {
  const cases = {
    'default selected with an unchecked project-only option': '<button role="radio" aria-checked="true"><span>Default memory</span></button><button role="radio" aria-checked="false"><span>Project-only memory</span></button>',
    'project-only option without a selection': '<button role="radio" aria-checked="false"><span>Project-only memory</span></button>',
    'generic explanatory text': '<p>Project-only memory</p>',
    'hidden selected control': '<button role="radio" aria-checked="true" hidden>Project-only</button>',
    'hidden readonly metadata': '<div aria-hidden="true"><span data-testid="project-memory-mode">Project-only memory</span></div>',
    'default selection with contradictory readonly metadata': '<button role="radio" aria-checked="true">Default memory</button><span data-testid="project-memory-mode">Project-only memory</span>',
    'two checked choices': '<button role="radio" aria-checked="true">Default memory</button><button role="radio" aria-checked="true">Project-only</button>',
    'selected choice contradicts readonly metadata': '<button role="radio" aria-checked="true">Project-only</button><span data-testid="project-memory-mode">Default memory</span>',
    'readonly marker inside an unchecked option': '<button role="radio" aria-checked="false"><span data-project-memory>Project-only memory</span></button>',
  }
  for (const [name, content] of Object.entries(cases)) {
    const f = dom(`<div role="dialog">${content}<textarea name="instructions"></textarea></div>`)
    assert.equal(f.call<ReturnType<typeof projectSettingsEvidence>>(projectSettingsEvidence).projectOnly, false, name)
  }
})

test('project memory evidence accepts one explicit selected mode or visible readonly mode metadata', () => {
  for (const content of [
    '<button role="radio" aria-checked="true">Project-only</button><button role="radio" aria-checked="false">Default memory</button>',
    '<button data-state="checked">Project-only memory</button>',
    '<span data-testid="project-memory-mode">Project-only memory</span>',
    '<div data-project-memory>仅限项目记忆</div>',
  ]) {
    const f = dom(`<div role="dialog">${content}<textarea name="instructions"></textarea></div>`)
    assert.equal(f.call<ReturnType<typeof projectSettingsEvidence>>(projectSettingsEvidence).projectOnly, true, content)
  }
})

test('project sources never let an empty-state label override a nonzero or unknown count', () => {
  for (const count of ['2', 'Loading', '']) {
    const f = dom(`<main><p>No files added yet</p><span data-testid="project-sources-count">${count}</span></main>`)
    assert.equal(f.call(projectSourcesEvidence), false, `explicit count ${JSON.stringify(count)}`)
  }
  const f = dom('<main><span data-testid="project-sources-count" hidden>0</span></main>')
  assert.equal(f.call(projectSourcesEvidence), false, 'hidden zero is not current source evidence')
  f.document.body.innerHTML = '<main><span data-testid="project-sources-count">0</span></main>'
  assert.equal(f.call(projectSourcesEvidence), true)
  f.document.body.innerHTML = '<main><span data-testid="project-sources-count">0</span><span data-testid="project-sources-count">2</span></main>'
  assert.equal(f.call(projectSourcesEvidence), false, 'conflicting counts cannot prove an empty project')
})

test('project sharing requires current private evidence and rejects public or unchecked labels', () => {
  for (const content of [
    '<button role="radio" aria-checked="true"><span>Anyone with link</span></button><button role="radio" aria-checked="false"><span>Only you</span></button>',
    '<button role="radio" aria-checked="false"><span>Only you</span></button>',
    '<span>Only you</span>',
    '<span data-testid="project-sharing-mode" hidden>Only you</span>',
    '<button role="radio" aria-checked="true">Anyone with link</button><span data-testid="project-sharing-mode">Only you</span>',
    '<button role="radio" aria-checked="true">Only you</button><span data-testid="project-sharing-mode">Anyone with link</span>',
  ]) {
    const f = dom(`<div role="dialog">${content}</div>`)
    assert.equal(f.call(projectSharingEvidence), false, content)
  }
  for (const content of [
    '<span data-testid="project-sharing-mode">Only you</span>',
    '<button role="radio" aria-checked="true">Only you</button><button role="radio" aria-checked="false">Anyone with link</button>',
  ]) {
    const f = dom(`<div role="dialog">${content}</div>`)
    assert.equal(f.call(projectSharingEvidence), true, content)
  }
})

test('project instructions require visible empty fields without contradictory content', () => {
  for (const content of [
    '<textarea name="instructions" hidden></textarea><textarea name="instructions">Unbound instruction</textarea>',
    '<textarea name="instructions"></textarea><div data-testid="project-instructions">Unbound instruction</div>',
    '<span>No instructions</span>',
  ]) {
    const f = dom(`<div role="dialog"><span data-testid="project-memory-mode">Project-only memory</span>${content}</div>`)
    assert.equal(f.call<ReturnType<typeof projectSettingsEvidence>>(projectSettingsEvidence).emptyInstructions, false, content)
  }
})

test('managed prepare drives real DOM admission and rejects a moved composer before text submission', async () => {
  const f = dom('')
  let active: HTMLElement | undefined
  let intent = false
  let projectExists = false
  let creates = 0
  let submits = 0
  const projectUrl = 'https://chatgpt.com/g/g-p-fixture/project'
  Object.defineProperty(f.document,'readyState',{value:'complete',configurable:true})
  Object.defineProperty(f.window.HTMLElement.prototype,'focus',{configurable:true,value(this:HTMLElement){active=this}})
  const append = (html:string):HTMLElement => { const holder=f.document.createElement('div');holder.innerHTML=html;const node=holder.firstElementChild as HTMLElement;f.document.body.append(node);return node }
  const render = ():void => {
    f.document.body.innerHTML = `<nav><button id="new-project">New project</button></nav><header><button data-testid="project-menu-button">Project menu</button><button id="share">Share project</button></header><button data-testid="accounts-profile-button">Account</button><button data-codex-intelligence-trigger="true" aria-expanded="false">Model</button><main>${projectExists?'<p>No files added yet</p>':''}</main><form data-chatgpt-composer><textarea id="prompt-textarea"></textarea><button type="button" data-testid="send-button">Send</button></form>`
    f.document.querySelector('[data-testid="accounts-profile-button"]')!.addEventListener('click',()=>append('<div role="menu"><span>fixture@example.invalid</span></div>'))
    f.document.querySelector('[data-testid="send-button"]')!.addEventListener('click',()=>{submits++})
    f.document.querySelector('[data-codex-intelligence-trigger]')!.addEventListener('click',(event)=>{
      (event.currentTarget as Element).setAttribute('aria-expanded','true')
      append('<div role="menu"><button role="menuitemradio" aria-checked="true">GPT-6</button><button role="menuitemradio" aria-checked="true">Pro</button></div>')
    })
    f.document.getElementById('new-project')!.addEventListener('click',()=>{
      assert.equal(intent,false,'opening a local dialog is not yet a hosted container mutation')
      const dialog=append('<div role="dialog"><input type="text"><button role="radio" aria-checked="false">Project-only</button><button id="create">Create project</button></div>')
      dialog.querySelector('[role="radio"]')!.addEventListener('click',(event)=>(event.currentTarget as Element).setAttribute('aria-checked','true'))
      dialog.querySelector('#create')!.addEventListener('click',()=>{assert.equal(intent,true,'WAL intent must precede hosted container creation');assert.equal(dialog.querySelector<HTMLInputElement>('input')!.value,'Meaningful review');creates++;projectExists=true;f.location.href=projectUrl;render()})
    })
    f.document.querySelector('[data-testid="project-menu-button"]')!.addEventListener('click',()=>{
      const menu=append('<div role="menu"><button role="menuitem">Project settings</button></div>')
      menu.querySelector('button')!.addEventListener('click',()=>{menu.remove();append('<div role="dialog"><button role="radio" aria-checked="true">Project-only</button><textarea name="instructions"></textarea></div>')})
    })
    f.document.getElementById('share')!.addEventListener('click',()=>append('<div role="dialog"><span data-testid="project-sharing-mode">Only you</span></div>'))
  }
  const raw = {
    targetId:'owned-fixture',sessionId:'fixture',cdp:{beginCleanup(){}},
    async evaluate<T>(expression:string):Promise<T>{return f.evaluate<T>(expression)},
    async navigate(url:string){f.location.href=url;render()},
    async insertText(text:string){assert.ok(active);if(active.tagName==='INPUT'||active.tagName==='TEXTAREA')(active as HTMLInputElement).value=text;else active.textContent=text},
    async escape(){for(const node of f.document.querySelectorAll('[role="dialog"],[role="menu"]'))node.remove();f.document.querySelector('[data-codex-intelligence-trigger]')?.setAttribute('aria-expanded','false')},
    async close(){},
  } as unknown as CdpPage
  const connection:WebConnection={id:'fixture',browserPath:'/unused',profilePath:'/unused/profile',stateDir:'/unused/state',accountFingerprint:digest('fixture@example.invalid')}
  const request:WebTurnRequest={requestId:'fixture',executionDomainId:'domain',sessionId:'session',generation:0,bindingDigest:digest('binding'),prompt:'prompt',title:'Meaningful review',deadlineMs:Date.now()+5000,contextPolicy:'project-only',maxPromptBytes:1000,maxResponseBytes:1000}
  const page=new ChatGptPage(raw,connection,request)
  const prepared=await page.prepare(request,async()=>{intent=true})
  assert.equal(creates,1)
  assert.equal(prepared.conversation.projectUrl,projectUrl)
  assert.equal(prepared.evidence.model,'GPT-6');assert.equal(prepared.evidence.effort,'Pro')
  assert.equal(prepared.evidence.accountFingerprint,connection.accountFingerprint)
  f.location.href = 'https://chatgpt.com/c/unrelated-personal-chat'
  await assert.rejects(() => page.submit(request.prompt), /Owned conversation changed/)
  assert.equal(submits, 0, 'a new managed project must remain bound before its first prompt, including text-only calls')
})
