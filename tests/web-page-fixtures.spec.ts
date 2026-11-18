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
  f.document.body.innerHTML = '<main><p>No files added yet</p></main><div role="dialog"><button role="radio" aria-checked="true">Project-only</button><textarea name="instructions"></textarea><span>Only you</span></div>'
  assert.equal(f.call<ReturnType<typeof projectSettingsEvidence>>(projectSettingsEvidence).projectOnly, true)
  assert.equal(f.call(projectSourcesEvidence), true); assert.equal(f.call(projectSharingEvidence), true)
  const member = f.document.createElement('span'); member.setAttribute('data-testid', 'project-member'); member.setAttribute('data-role', 'member')
  f.document.querySelector('[role="dialog"]')!.append(member)
  assert.equal(f.call(projectSharingEvidence), false)
})

test('managed prepare drives real DOM creation/settings/share controls after account and WAL admission', async () => {
  const f = dom('')
  let active: HTMLElement | undefined
  let intent = false
  let projectExists = false
  let creates = 0
  const projectUrl = 'https://chatgpt.com/g/g-p-fixture/project'
  Object.defineProperty(f.document,'readyState',{value:'complete',configurable:true})
  Object.defineProperty(f.window.HTMLElement.prototype,'focus',{configurable:true,value(this:HTMLElement){active=this}})
  const append = (html:string):HTMLElement => { const holder=f.document.createElement('div');holder.innerHTML=html;const node=holder.firstElementChild as HTMLElement;f.document.body.append(node);return node }
  const render = ():void => {
    f.document.body.innerHTML = `<nav><button id="new-project">New project</button></nav><header><button data-testid="project-menu-button">Project menu</button><button id="share">Share project</button></header><button data-testid="accounts-profile-button">Account</button><button data-codex-intelligence-trigger="true" aria-expanded="false">Model</button><main>${projectExists?'<p>No files added yet</p>':''}</main><textarea id="prompt-textarea"></textarea>`
    f.document.querySelector('[data-testid="accounts-profile-button"]')!.addEventListener('click',()=>append('<div role="menu"><span>fixture@example.invalid</span></div>'))
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
    f.document.getElementById('share')!.addEventListener('click',()=>append('<div role="dialog"><span>Only you</span></div>'))
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
})
