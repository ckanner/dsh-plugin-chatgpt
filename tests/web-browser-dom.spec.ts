import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CdpConnection, CdpPage } from '../src/web/browser/cdp.ts'
import { modelSelectionAction, snapshotPage, projectSettingsEvidence, projectSourcesEvidence, projectSharingEvidence } from '../src/web/browser/page.ts'
import { wait } from '../src/web/browser/storage.ts'
import { imageUploadEvidence } from '../src/web/browser/media-dom.ts'

test('production DOM adapter runs against real Chromium fixtures', async (t) => {
  const executable=process.env.CHATGPT_WEB_TEST_CHROMIUM
  if (!executable) { t.skip('Set CHATGPT_WEB_TEST_CHROMIUM to run the isolated real browser fixture'); return }
  await access(executable)
  const root=await mkdtemp(join(tmpdir(),'dsh-web-dom-'))
  const child=spawn(executable,['--headless=new','--no-sandbox','--disable-gpu','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',`--user-data-dir=${root}`,'about:blank'],{stdio:['ignore','ignore','pipe']})
  let startupError: Error | undefined
  let stderr=''
  child.once('error',error=>{startupError=error})
  child.stderr.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-8192)})
  let cdp:CdpConnection|undefined
  try {
    const deadline=Date.now()+20_000
    let endpoint:string|undefined
    for(;;) {
      if(startupError) throw startupError
      if(child.exitCode!==null || child.signalCode!==null) throw new Error(`Fixture browser exited before CDP became available: ${stderr}`)
      try { const [port,path]=(await readFile(join(root,'DevToolsActivePort'),'utf8')).trim().split('\n');endpoint=`ws://127.0.0.1:${port}${path}`;break } catch { await wait(100,deadline) }
    }
    cdp=await CdpConnection.connect(endpoint,Date.now()+60_000)
    const page=await CdpPage.create(cdp)
    const html=async(value:string)=>page.evaluate<void>(`document.body.innerHTML=${JSON.stringify(value)}`)
    const call=async<T>(fn:Function,...args:unknown[]):Promise<T>=>page.evaluate<T>(`(${fn.toString()})(${args.map(v=>JSON.stringify(v)).join(',')})`)

    await t.test('Pro alone and a stale GPT version are insufficient model evidence',async()=>{
      await html('<div role="menu"><button role="menuitemradio" aria-checked="true">Pro</button></div>')
      assert.equal((await call<{ready:boolean}>(modelSelectionAction,'verify','button')).ready,false)
      await html('<div role="menu"><button role="menuitemradio" aria-checked="true">GPT-5.6 Sol</button><button role="menuitemradio" aria-checked="true">Pro</button></div>')
      assert.equal((await call<{ready:boolean}>(modelSelectionAction,'verify','button')).ready,false)
    })

    await t.test('GPT-6 radio and announced Pro slider jointly prove selection',async()=>{
      await html('<div role="menu"><button role="menuitemradio" aria-checked="true">GPT-6</button><div data-reasoning-slider><div tabindex="0" role="slider" aria-valuenow="1" aria-valuemin="0" aria-valuemax="4" aria-describedby="announcement">Slider</div></div></div><span id="announcement">Medium, 2 of 5.</span>')
      await page.evaluate<void>(`document.querySelector('[role="slider"]').addEventListener('keydown',e=>{if(e.key==='ArrowRight'){const n=e.currentTarget;const value=Math.min(4,Number(n.getAttribute('aria-valuenow'))+1);n.setAttribute('aria-valuenow',String(value));document.getElementById('announcement').textContent=['Instant','Medium','High','Extra High','Pro'][value]+', '+(value+1)+' of 5.';}})`)
      for(let i=0;i<3;i++) assert.equal((await call<{ready:boolean}>(modelSelectionAction,'select','button')).ready,false)
      assert.deepEqual(await call(modelSelectionAction,'verify','button'),{ready:true,model:'GPT-6',effort:'Pro'})
      await page.evaluate<void>(`document.getElementById('announcement').textContent='';document.querySelector('[role="slider"]').removeAttribute('aria-valuetext')`)
      assert.equal((await call<{ready:boolean}>(modelSelectionAction,'verify','button')).ready,false)
    })

    await t.test('message identity and scoped finished actions exclude code-copy and quoted errors',async()=>{
      await html('<article data-testid="conversation-turn-1"><div data-message-author-role="user" data-message-id="u1">prompt</div></article><article data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="a1"><div class="markdown">answer<pre><button aria-label="Copy">copy code</button></pre><div role="alert">rate limit quoted in answer</div></div></div></article><div data-testid="thinking-indicator">Thinking</div><textarea id="prompt-textarea"></textarea>')
      let snapshot=await call<ReturnType<typeof snapshotPage>>(snapshotPage)
      assert.equal(snapshot.messages[1]?.id,'a1');assert.equal(snapshot.messages[1]?.finished,false)
      assert.equal(snapshot.errorText,'');assert.equal(snapshot.thinkingVisible,true)
      await page.evaluate<void>(`const b=document.createElement('button');b.dataset.testid='copy-turn-action-button';b.textContent='Copy';document.querySelector('[data-testid="conversation-turn-2"]').append(b);document.querySelector('[data-testid="thinking-indicator"]').remove()`)
      snapshot=await call<ReturnType<typeof snapshotPage>>(snapshotPage)
      assert.equal(snapshot.messages[1]?.finished,true);assert.equal(snapshot.thinkingVisible,false)
    })

    await t.test('project-only, empty instructions and sources are observed rather than inferred from names',async()=>{
      await html('<main><h1>Private project-only project</h1></main><div role="dialog"><h2>Project settings</h2><span>Default memory</span><textarea name="instructions"></textarea></div>')
      assert.deepEqual(await call(projectSettingsEvidence),{projectOnly:false,emptyInstructions:true})
      assert.equal(await call(projectSourcesEvidence),false)
      await html('<main><p>No files added yet</p></main><div role="dialog"><h2>Project settings</h2><button role="radio" aria-checked="true">Project-only</button><textarea name="instructions"></textarea></div>')
      assert.deepEqual(await call(projectSettingsEvidence),{projectOnly:true,emptyInstructions:true})
      assert.equal(await call(projectSourcesEvidence),true)
      await page.evaluate<void>(`document.querySelector('textarea').value='unbound instructions';const source=document.createElement('div');source.dataset.testid='project-source';document.querySelector('main').append(source)`)
      assert.deepEqual(await call(projectSettingsEvidence),{projectOnly:true,emptyInstructions:false})
      assert.equal(await call(projectSourcesEvidence),false)
    })

    await t.test('sharing evidence rejects collaborators and public links',async()=>{
      await html('<div role="dialog"><h2>Share project</h2><span>Only you</span></div>')
      assert.equal(await call(projectSharingEvidence),true)
      await page.evaluate<void>(`const n=document.createElement('div');n.dataset.testid='project-member';n.dataset.role='member';document.querySelector('[role="dialog"]').append(n)`)
      assert.equal(await call(projectSharingEvidence),false)
      await html('<div role="dialog"><span>Only you</span><a data-testid="project-public-link" href="https://example.invalid">Public link</a></div>')
      assert.equal(await call(projectSharingEvidence),false)
    })

    await t.test('CDP selects exact private image bytes and DOM completion never follows a preview alone', async () => {
      const name = `dsh-${'a'.repeat(20)}-${'b'.repeat(20)}.png`
      const path = join(root, name)
      const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/an8AAAAASUVORK5CYII=', 'base64')
      await writeFile(path, bytes, { mode: 0o600 })
      await html('<form data-chatgpt-composer><textarea id="prompt-textarea"></textarea><input type="file" multiple><button data-testid="send-button">Send</button></form>')
      await page.evaluate<void>(`document.querySelector('input').addEventListener('change',e=>{const file=e.target.files[0];const tile=document.createElement('div');tile.dataset.testid='file-upload';tile.dataset.filename=file.name;tile.dataset.uploadStatus='uploading';tile.innerHTML='<span role="progressbar"></span>';document.querySelector('form').append(tile);window.fixtureImageBytes=file.arrayBuffer().then(bytes=>[...new Uint8Array(bytes)]);})`)
      await page.setFileInputFiles([path], 'about:blank')
      const pending = await call<ReturnType<typeof imageUploadEvidence>>(imageUploadEvidence)
      assert.equal(pending.cards[0]?.ready, false)
      assert.equal(pending.busy, true)
      assert.deepEqual(await page.evaluate<number[]>('window.fixtureImageBytes'), [...bytes])
      await page.evaluate<void>(`const tile=document.querySelector('[data-testid="file-upload"]');tile.dataset.uploadStatus='complete';tile.dataset.fileId='remote-fixture-image';tile.querySelector('[role="progressbar"]').remove()`)
      const complete = await call<ReturnType<typeof imageUploadEvidence>>(imageUploadEvidence)
      assert.equal(complete.cards[0]?.name, name)
      assert.equal(complete.cards[0]?.ready, true)
      await assert.rejects(() => page.setFileInputFiles([path], 'https://chatgpt.com/c/different'), /unavailable/)
    })

    await page.close();cdp=undefined
  } finally {
    cdp?.close()
    child.kill('SIGTERM')
    await new Promise<void>(resolve=>{if(startupError || child.exitCode!==null || child.signalCode!==null)resolve();else child.once('exit',()=>resolve())})
    await rm(root,{recursive:true,force:true})
  }
})
