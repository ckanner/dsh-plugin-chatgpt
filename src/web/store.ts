import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { digest, WebPolicyError } from './policy.ts'

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' }

/** Includes the serialized authoritative request, tool arguments and commit metadata. */
export const WEB_RECORD_MAX_BYTES = 32 * 1024 * 1024

interface LockClaim { version: 1; pid: number; nonce: string; choosing: boolean; ticket: number }

async function syncLockDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(directory, constants.O_RDONLY)
  try { await handle.sync() } finally { await handle.close() }
}

async function publishClaim(path: string, claim: LockClaim): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(JSON.stringify(claim)); await handle.sync() } finally { await handle.close() }
  try {
    if(claim.choosing)await link(temp,path)
    else await rename(temp,path)
    await syncLockDirectory(dirname(path))
  }
  finally { await rm(temp,{force:true}) }
}

function deadOwner(pid: number): boolean {
  if (pid === process.pid) return false
  try { process.kill(pid,0); return false }
  catch (error) {
    // EPERM and PID reuse are deliberately treated as live. Only positive
    // evidence that this PID no longer exists allows removal of its claim.
    return (error as NodeJS.ErrnoException)?.code === 'ESRCH'
  }
}

async function lockClaims(directory: string): Promise<LockClaim[]> {
  const claims: LockClaim[] = []
  for (const name of await readdir(directory)) {
    if (!/^\d+-[a-f0-9-]{36}\.json$/.test(name)) continue
    const path = join(directory,name)
    let handle
    try { handle = await open(path,constants.O_RDONLY|constants.O_NOFOLLOW) }
    catch (error) { if(missing(error))continue;throw error }
    let claim:LockClaim
    try {
      const stat=await handle.stat()
      if(!stat.isFile()||stat.size>2048||(stat.mode&0o077)!==0||(process.getuid&&stat.uid!==process.getuid())) throw new WebPolicyError('unsafe Web lock owner record')
      claim=JSON.parse(await handle.readFile('utf8')) as LockClaim
    } finally { await handle.close() }
    if(claim.version!==1||!Number.isSafeInteger(claim.pid)||claim.pid<1||typeof claim.nonce!=='string'||name!==`${claim.pid}-${claim.nonce}.json`||typeof claim.choosing!=='boolean'||!Number.isSafeInteger(claim.ticket)||claim.ticket<0) throw new WebPolicyError('invalid Web lock owner record')
    if(deadOwner(claim.pid)) {
      // Each claim's nonce is unique and never reused. Two reapers may unlink
      // this old name, but neither can delete a newly admitted owner's file.
      await rm(path,{force:true});continue
    }
    claims.push(claim)
  }
  return claims
}

/**
 * Cross-process Lamport bakery lock over private local files. Publishing a
 * choosing marker before selecting a ticket closes the concurrent-entry race.
 * Unique claim names avoid the read-old-lock/unlink-new-lock (ABA) race when a
 * crashed owner is reaped. The lock directory is persistent and never removed.
 */
export async function withOwnerLock<T>(directory: string, operation: () => Promise<T>, options: { waitMs?: number; signal?: AbortSignal } = {}): Promise<T> {
  const waitMs=options.waitMs??2000
  if(!Number.isFinite(waitMs)||waitMs<0||waitMs>60_000) throw new WebPolicyError('invalid Web lock wait budget')
  await mkdir(directory,{recursive:true,mode:0o700})
  const stat=await lstat(directory)
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||(process.getuid&&stat.uid!==process.getuid()))throw new WebPolicyError('unsafe Web lock directory')
  const deadline=Date.now()+waitMs
  const claim:LockClaim={version:1,pid:process.pid,nonce:randomUUID(),choosing:true,ticket:0}
  const path=join(directory,`${claim.pid}-${claim.nonce}.json`)
  function cancelled():void {if(options.signal?.aborted)throw options.signal.reason??new WebPolicyError('Web lock cancelled')}
  cancelled()
  await publishClaim(path,claim)
  try {
    const present=await lockClaims(directory)
    const maximum=Math.max(0,...present.map(owner=>owner.ticket))
    if(maximum>=Number.MAX_SAFE_INTEGER-1)throw new WebPolicyError('Web lock ticket space exhausted')
    claim.ticket=maximum+1;claim.choosing=false
    await publishClaim(path,claim)
    for(;;) {
      cancelled()
      const current=await lockClaims(directory)
      if(!current.some(owner=>owner.nonce===claim.nonce&&owner.pid===claim.pid))throw new WebPolicyError('Web lock owner disappeared')
      const blocked=current.some(owner=>owner.nonce!==claim.nonce&&(owner.choosing||owner.ticket<claim.ticket||(owner.ticket===claim.ticket&&owner.nonce<claim.nonce)))
      if(!blocked)return await operation()
      if(Date.now()>=deadline)throw new WebPolicyError('Web state is busy; its live owner was not replaced')
      await new Promise<void>(resolve=>setTimeout(resolve,Math.min(20,Math.max(1,deadline-Date.now()))))
    }
  } finally {await rm(path,{force:true});await syncLockDirectory(directory)}
}

/** Small owner-only journal records. Names are hashes; records never contain executable paths. */
export class WebStore {
  private root: string
  constructor(root: string) {
    if (!isAbsolute(root)) throw new WebPolicyError('Web state directory must be absolute')
    this.root = resolve(root)
  }

  private async directory(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const stat = await lstat(this.root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new WebPolicyError('Web state directory must be a real private directory')
    if (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) throw new WebPolicyError('Web state directory must be owned by this user with mode 0700')
    // macOS /var -> /private/var and other legitimate parent aliases are
    // canonicalized once. A symlink at the actual private leaf remains invalid.
    this.root = await realpath(this.root)
  }

  private path(namespace: string, key: string): string {
    if (!/^[a-z-]+$/.test(namespace)) throw new WebPolicyError('invalid journal namespace')
    return join(this.root, `${namespace}-${digest(key)}.json`)
  }

  async read<T>(namespace: string, key: string): Promise<T | undefined> {
    await this.directory()
    const path = this.path(namespace, key)
    let handle
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) { if (missing(error)) return; throw error }
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > WEB_RECORD_MAX_BYTES || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) throw new WebPolicyError('unsafe or oversized Web journal record')
      return JSON.parse(await handle.readFile('utf8')) as T
    } finally { await handle.close() }
  }

  async write(namespace: string, key: string, value: unknown): Promise<void> {
    await this.directory()
    const path = this.path(namespace, key)
    const text = JSON.stringify(value)
    if (Buffer.byteLength(text) > WEB_RECORD_MAX_BYTES) throw new WebPolicyError('Web journal record is too large')
    const temp = `${path}.${randomUUID()}.tmp`
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { await handle.writeFile(text); await handle.sync() } finally { await handle.close() }
    try { await rename(temp, path) } finally { await rm(temp, { force: true }) }
    const dir = await open(dirname(path), 'r')
    try { await dir.sync() } finally { await dir.close() }
  }

  /** Short transactions may recover a dead lock owner; journal recovery remains a separate operation. */
  async locked<T>(namespace: string, key: string, operation: () => Promise<T>): Promise<T> {
    await this.directory()
    return await withOwnerLock(`${this.path(namespace,key)}.mutex-v1`,operation)
  }
}
