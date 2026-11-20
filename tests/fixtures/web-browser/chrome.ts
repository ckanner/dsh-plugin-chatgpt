import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, type Browser, type Page } from 'playwright-core'
import { accountBindingForVisibleIdentity, createChromePageTransport, type ChromePageTransport, type ChromePageTransportOptions } from '../../../src/web-browser/index.ts'
import { BROWSER_LEDGER_FILE } from '../../../src/web-browser/ledger.ts'

export interface FixtureAction { kind: string, [key: string]: unknown }
export interface ChromeFixture {
 directory: string, profileDirectory: string, stateDirectory: string, cdpUrl: string, origin: string, page: Page,
 actions: FixtureAction[], intentKinds: string[], browser: Browser, process: ChildProcess,
 options: ChromePageTransportOptions,
 transport(extra?: Partial<ChromePageTransportOptions>): Promise<ChromePageTransport>,
 redirect(fromPath: string, toPath: string): void,
 set(value: Record<string, unknown>): Promise<void>, close(): Promise<void>
}
export async function chromeFixture(): Promise<ChromeFixture> {
 const directory=await mkdtemp(join(tmpdir(),'dsh-web-browser-'))
 const profileDirectory=join(directory,'profile'),stateDirectory=join(directory,'browser')
 await mkdir(profileDirectory,{mode:0o700})
 const html=await readFile(new URL('./fixture.html',import.meta.url),'utf8')
 const actions:FixtureAction[]=[],intentKinds:string[]=[]
 const redirects=new Map<string,string>()
 let nextId=1
 const server:Server=createServer(async(req,res)=>{
  const destination=redirects.get(req.url??'');if(destination){res.writeHead(302,{location:destination});res.end();return}
  if(req.url==='/__action'){
   let body='';for await(const chunk of req)body+=chunk
   const data=JSON.parse(body) as FixtureAction;actions.push(data)
   try {const saved=JSON.parse(await readFile(join(stateDirectory,BROWSER_LEDGER_FILE),'utf8'));intentKinds.push(saved.data.mutations.findLast((a:{state:string})=>a.state==='intent')?.kind??'NO_INTENT')}catch{intentKinds.push('NO_LEDGER')}
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'fixture-'+nextId++}));return
  }
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html)
 })
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
 const address=server.address();if(!address||typeof address==='string')throw Error('no fixture port')
 const origin=`http://127.0.0.1:${address.port}`
 const executable=process.env['DSH_TEST_CHROMIUM']??'/usr/bin/chromium'
 const child=spawn(executable,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--no-first-run','--no-default-browser-check','--enable-automation','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',`--user-data-dir=${profileDirectory}`,origin],{stdio:['ignore','ignore','pipe']})
 let stderr='';child.stderr?.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-8000)})
 let spawnError:unknown;child.once('error',error=>{spawnError=error})
 let processClosed=false
 const closed=new Promise<void>(resolve=>child.once('close',()=>{processClosed=true;resolve()}))
 let browser:Browser|undefined
 const waitClosed=(ms:number):Promise<boolean>=>{
  if(processClosed)return Promise.resolve(true)
  return new Promise(resolve=>{const timer=setTimeout(()=>resolve(false),ms);void closed.then(()=>{clearTimeout(timer);resolve(true)})})
 }
 let shutdown:Promise<void>|undefined
 const stopChrome=():Promise<void>=>shutdown??=(async()=>{
  if(browser?.isConnected()&&!processClosed){
   // Closing a CDP client only disconnects it. Ask this exact fixture browser
   // to stop all Chrome children before deleting its profile on disk.
   const session=await browser.newBrowserCDPSession().catch(()=>undefined)
   if(session)await Promise.race([session.send('Browser.close').catch(()=>undefined),delay(1000)])
  }
  await browser?.close().catch(()=>undefined)
  if(!await waitClosed(1500)){child.kill('SIGTERM');if(!await waitClosed(1500)){child.kill('SIGKILL');if(!await waitClosed(1500))throw Error('Fixture Chrome and its inherited pipes did not close; profile was retained')}}
 })()
 const closeServer=()=>new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections()})
 try {
  let port:string|undefined
  const deadline=Date.now()+15_000
  while(Date.now()<deadline){if(spawnError)throw spawnError;try{port=(await readFile(join(profileDirectory,'DevToolsActivePort'),'utf8')).split('\n')[0];if(port)break}catch{}if(child.exitCode!==null)throw Error(`Chromium exited ${child.exitCode}: ${stderr}`);await delay(50)}
  if(!port)throw Error(`Chromium did not publish its CDP endpoint: ${stderr}`)
  const cdpUrl=`http://127.0.0.1:${port}`
  browser=await chromium.connectOverCDP(cdpUrl)
  let page=browser.contexts()[0]!.pages()[0]
  if(!page)page=await browser.contexts()[0]!.newPage()
  if(!page.url().startsWith(origin))await page.goto(origin)
  await page.waitForSelector('#prompt-textarea')
  const options:ChromePageTransportOptions={cdpUrl,expectedProfileDirectory:profileDirectory,stateDirectory,expectedAccountBinding:accountBindingForVisibleIdentity('owner@example.test'),provider:'chatgpt',profileId:'fixture-profile',testOnlyOrigin:origin,timeoutMs:6000,initialize:true}
  const transportList:ChromePageTransport[]=[]
  const attached=browser
  return {directory,profileDirectory,stateDirectory,cdpUrl,origin,page,browser:attached,process:child,actions,intentKinds,options,
   async transport(extra={}){const t=await createChromePageTransport({...options,...extra});transportList.push(t);return t},
   redirect(fromPath,toPath){redirects.set(fromPath,toPath)},
   async set(value){await page!.evaluate(value=>{Object.assign((window as unknown as {fixture:Record<string,unknown>}).fixture,value);(window as unknown as {renderFixture():void}).renderFixture()},value)},
   async close(){
    const failures:unknown[]=[]
    for(const t of transportList)try{await t.close()}catch(error){failures.push(error)}
    let stopped=false
    try{await stopChrome();stopped=true}catch(error){failures.push(error)}finally{try{await closeServer()}catch(error){failures.push(error)}}
    if(stopped)try{await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100})}catch(error){failures.push(error)}
    if(failures.length)throw new AggregateError(failures,'Fixture transport cleanup failed')
   }}
 }catch(error){
  const failures:unknown[]=[error];let stopped=false
  try{await stopChrome();stopped=true}catch(cleanup){failures.push(cleanup)}finally{try{await closeServer()}catch(cleanup){failures.push(cleanup)}}
  if(stopped)try{await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100})}catch(cleanup){failures.push(cleanup)}
  if(failures.length>1)throw new AggregateError(failures,'Fixture initialization and cleanup failed')
  throw error
 }
}
