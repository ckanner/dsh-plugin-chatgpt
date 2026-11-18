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
  let closed=false
  const childClosed=new Promise<void>(resolve=>child.once('close',()=>{closed=true;resolve()}))
  const awaitClose=async(milliseconds:number):Promise<boolean>=>{
    if(closed)return true
    let timer:ReturnType<typeof setTimeout>|undefined
    try{return await Promise.race([childClosed.then(()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),milliseconds)})])}
    finally{clearTimeout(timer)}
  }
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
      for (const memory of [
        '<button role="radio" aria-checked="true">Default memory</button><button role="radio" aria-checked="false"><span>Project-only memory</span></button>',
        '<button role="radio" aria-checked="true">Default memory</button><span data-testid="project-memory-mode">Project-only memory</span>',
        '<button role="radio" aria-checked="true" hidden>Project-only</button>',
        '<div style="display:none"><span data-testid="project-memory-mode">Project-only memory</span></div>',
        '<p>Project-only memory</p>',
      ]) {
        await html(`<div role="dialog">${memory}<textarea name="instructions"></textarea></div>`)
        assert.deepEqual(await call(projectSettingsEvidence),{projectOnly:false,emptyInstructions:true},memory)
      }
      await html('<div role="dialog"><span data-testid="project-memory-mode">Project-only memory</span><textarea name="instructions"></textarea></div>')
      assert.deepEqual(await call(projectSettingsEvidence),{projectOnly:true,emptyInstructions:true})
      await html('<main><p>No files added yet</p></main><div role="dialog"><h2>Project settings</h2><button role="radio" aria-checked="true">Project-only</button><textarea name="instructions"></textarea></div>')
      assert.deepEqual(await call(projectSettingsEvidence),{projectOnly:true,emptyInstructions:true})
      assert.equal(await call(projectSourcesEvidence),true)
      await page.evaluate<void>(`document.querySelector('textarea').value='unbound instructions';const source=document.createElement('div');source.dataset.testid='project-source';document.querySelector('main').append(source)`)
      assert.deepEqual(await call(projectSettingsEvidence),{projectOnly:true,emptyInstructions:false})
      assert.equal(await call(projectSourcesEvidence),false)
      await html('<div role="dialog"><span data-testid="project-memory-mode">Project-only memory</span><textarea name="instructions" hidden></textarea><textarea name="instructions">Unbound instruction</textarea></div>')
      assert.deepEqual(await call(projectSettingsEvidence),{projectOnly:true,emptyInstructions:false})
      for (const count of ['2','Loading','']) {
        await html(`<main><p>No files added yet</p><span data-testid="project-sources-count">${count}</span></main>`)
        assert.equal(await call(projectSourcesEvidence),false)
      }
      await html('<main><span data-testid="project-sources-count" hidden>0</span></main>')
      assert.equal(await call(projectSourcesEvidence),false)
      await html('<main><span data-testid="project-sources-count">0</span></main>')
      assert.equal(await call(projectSourcesEvidence),true)
    })

    await t.test('sharing evidence rejects collaborators and public links',async()=>{
      await html('<div role="dialog"><h2>Share project</h2><span data-testid="project-sharing-mode">Only you</span></div>')
      assert.equal(await call(projectSharingEvidence),true)
      await page.evaluate<void>(`const n=document.createElement('div');n.dataset.testid='project-member';n.dataset.role='member';document.querySelector('[role="dialog"]').append(n)`)
      assert.equal(await call(projectSharingEvidence),false)
      await html('<div role="dialog"><span data-testid="project-sharing-mode">Only you</span><a data-testid="project-public-link" href="https://example.invalid">Public link</a></div>')
      assert.equal(await call(projectSharingEvidence),false)
      for (const sharing of [
        '<button role="radio" aria-checked="true">Anyone with link</button><button role="radio" aria-checked="false"><span>Only you</span></button>',
        '<button role="radio" aria-checked="true">Anyone with link</button><span data-testid="project-sharing-mode">Only you</span>',
        '<span data-testid="project-sharing-mode" hidden>Only you</span>',
        '<span>Only you</span>',
      ]) {
        await html(`<div role="dialog">${sharing}</div>`)
        assert.equal(await call(projectSharingEvidence),false)
      }
      await html('<div role="dialog"><button role="radio" aria-checked="true">Only you</button><button role="radio" aria-checked="false">Anyone with link</button></div>')
      assert.equal(await call(projectSharingEvidence),true)
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

  } finally {
    try {
      if(cdp){
        cdp.beginCleanup()
        // The entire browser belongs to this fixture. Ask Chrome to flush its
        // profile before detaching; production page cleanup remains detach-only.
        try{await cdp.command('Browser.close')}catch(error){t.diagnostic(`Browser close response unavailable; awaiting owned process shutdown: ${String(error)}`)}
        cdp.close()
      }
      if(!await awaitClose(5_000)){
        child.kill('SIGTERM')
        if(!await awaitClose(5_000)){
          child.kill('SIGKILL')
          if(!await awaitClose(5_000))throw new Error('Owned fixture browser did not close after termination')
        }
      }
    } finally {
      // macOS can finish a profile write after the browser's main exit event.
      // Wait for stdio close above and retry only the bounded filesystem race.
      await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:200})
    }
  }
})
