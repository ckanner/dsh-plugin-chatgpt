import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { WEB_RECORD_MAX_BYTES, WebStore, withOwnerLock } from '../src/web/store.ts'

async function exited(child:ChildProcess):Promise<void> {
  if(child.exitCode!==null||child.signalCode!==null)return
  await new Promise<void>((resolve,reject)=>{child.once('exit',()=>resolve());child.once('error',reject)})
}

test('owner lock serializes concurrent contenders and removes only its own unique claim',async()=>{
  const root=await mkdtemp(join(tmpdir(),'web-owner-lock-'))
  try {
    let active=0;let finished=0
    await Promise.all(Array.from({length:12},()=>withOwnerLock(join(root,'mutex'),async()=>{
      assert.equal(++active,1)
      await new Promise<void>(resolve=>setTimeout(resolve,3))
      active--;finished++
    },{waitMs:4000})))
    assert.equal(finished,12)
    assert.deepEqual((await readdir(join(root,'mutex'))).filter(name=>name.endsWith('.json')),[])
  }finally{await rm(root,{recursive:true,force:true})}
})

test('a live owner is not stolen; bounded wait and cancellation remove their own claims',async()=>{
  const root=await mkdtemp(join(tmpdir(),'web-live-owner-'))
  let release!:()=>void;let entered!:()=>void
  const ready=new Promise<void>(resolve=>{entered=resolve})
  const blocker=new Promise<void>(resolve=>{release=resolve})
  const owner=withOwnerLock(join(root,'mutex'),async()=>{entered();await blocker})
  try {
    await ready
    await assert.rejects(withOwnerLock(join(root,'mutex'),async()=>assert.fail('must not enter'),{waitMs:30}),/live owner/)
    const abort=new AbortController();abort.abort(new Error('test cancellation'))
    await assert.rejects(withOwnerLock(join(root,'mutex'),async()=>assert.fail('must not enter'),{signal:abort.signal}),/test cancellation/)
    assert.equal((await readdir(join(root,'mutex'))).filter(name=>name.endsWith('.json')).length,1)
  }finally{release();await owner;await rm(root,{recursive:true,force:true})}
})

test('a crashed process owner is reaped concurrently without removing new owners',async()=>{
  const root=await mkdtemp(join(tmpdir(),'web-dead-owner-'))
  const lock=join(root,'mutex')
  const source=new URL('../src/web/store.ts',import.meta.url).href
  const child=spawn(process.execPath,['--input-type=module','-e',`import {withOwnerLock} from ${JSON.stringify(source)};await withOwnerLock(process.argv[1],async()=>{process.stdout.write('entered\\n');await new Promise(r=>setTimeout(r,60000));});`,lock],{stdio:['ignore','pipe','pipe']})
  try {
    await new Promise<void>((resolve,reject)=>{
      child.stdout!.once('data',()=>resolve());child.once('error',reject);child.once('exit',code=>reject(new Error('owner exited early '+code)))
    })
    child.kill('SIGKILL');await exited(child)
    let active=0;let finishes=0
    await Promise.all(Array.from({length:6},()=>withOwnerLock(lock,async()=>{
      assert.equal(++active,1);await new Promise<void>(resolve=>setTimeout(resolve,5));active--;finishes++
    },{waitMs:3000})))
    assert.equal(finishes,6)
    assert.deepEqual((await readdir(lock)).filter(name=>name.endsWith('.json')),[])
  }finally{child.kill('SIGKILL');await exited(child);await rm(root,{recursive:true,force:true})}
})

test('independent processes coordinate the same state transaction',async()=>{
  const root=await mkdtemp(join(tmpdir(),'web-cross-process-'))
  const counter=join(root,'counter');await writeFile(counter,'0')
  const source=new URL('../src/web/store.ts',import.meta.url).href
  const script=`import {withOwnerLock} from ${JSON.stringify(source)};import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';for(let i=0;i<4;i++)await withOwnerLock(join(process.argv[1],'mutex'),async()=>{const p=join(process.argv[1],'counter');const n=Number(await readFile(p,'utf8'));await new Promise(r=>setTimeout(r,3));await writeFile(p,String(n+1));},{waitMs:5000});`
  const children=Array.from({length:3},()=>spawn(process.execPath,['--input-type=module','-e',script,root],{stdio:'pipe'}))
  try {
    await Promise.all(children.map(exited))
    assert.ok(children.every(child=>child.exitCode===0),'all independent contenders finish normally')
    assert.equal(await readFile(counter,'utf8'),'12')
  }finally{for(const child of children)child.kill('SIGKILL');await rm(root,{recursive:true,force:true})}
})

test('WebStore canonicalizes a parent alias while refusing a symlink private leaf',async()=>{
  const root=await mkdtemp(join(tmpdir(),'web-state-alias-'))
  try {
    const actual=join(root,'actual');await mkdir(actual,{mode:0o700})
    const alias=join(root,'parent-alias');await symlink(actual,alias,'dir')
    const store=new WebStore(join(alias,'private'))
    await store.write('state','test',{ok:true})
    assert.deepEqual(await new WebStore(join(actual,'private')).read('state','test'),{ok:true})
    await symlink(join(actual,'private'),join(root,'leaf-alias'),'dir')
    await assert.rejects(new WebStore(join(root,'leaf-alias')).read('state','test'),/real private directory/)
  }finally{await rm(root,{recursive:true,force:true})}
})

test('delivery-sized records exceed the old 8 MiB ceiling while reads and writes share a bounded 32 MiB limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'web-record-budget-'))
  try {
    const store = new WebStore(join(root, 'private'))
    const delivery = { version: 1, recovery: { request: { prompt: 'p'.repeat(4 * 1024 * 1024) } }, blocks: [{ type: 'tool-call', arguments: 'a'.repeat(5 * 1024 * 1024) }] }
    assert.ok(Buffer.byteLength(JSON.stringify(delivery)) > 8 * 1024 * 1024)
    await store.write('delivery', 'large', delivery)
    const observed = await store.read<typeof delivery>('delivery', 'large')
    assert.equal(observed?.recovery.request.prompt.length, delivery.recovery.request.prompt.length)
    assert.equal(observed?.blocks[0]?.arguments.length, delivery.blocks[0]!.arguments.length)
    const oversized = 'x'.repeat(WEB_RECORD_MAX_BYTES + 1024 * 1024)
    await assert.rejects(store.write('delivery', 'large', { text: oversized }), /too large/)
    assert.equal((await store.read<typeof delivery>('delivery', 'large'))?.version, 1, 'a rejected write preserves its existing record')
    const filename = (await readdir(join(root, 'private'))).find(name => name.endsWith('.json'))!
    await writeFile(join(root, 'private', filename), oversized, { mode: 0o600 })
    await assert.rejects(store.read('delivery', 'large'), /oversized/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
