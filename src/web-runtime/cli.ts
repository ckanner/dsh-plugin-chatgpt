#!/usr/bin/env node
/** User commands never accept prompt text, shell fragments, or bearer tokens. */
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { ManagedWebRuntime } from './index.ts'
import { startRuntimeDaemon } from './daemon.ts'
import { runtimeError } from './storage.ts'
import { WebBridgeError } from '../web-bridge/contracts.ts'
import type { ManagedWebRuntimeOptions } from './types.ts'

export async function runWebBridgeCli(argv = process.argv.slice(2), output: (text: string) => void = text => process.stdout.write(text)): Promise<number> {
  const command = argv[0]
  if (!command || command === '--help' || command === 'help') {
    output('Usage: dsh-chatgpt-web <setup|status|verify|enable|disable|turns|inspect|recover|discard> --state-directory PATH [--provider NAME] [TURN_ID]\n')
    return 0
  }
  const options: ManagedWebRuntimeOptions = { stateDirectory: '', provider: 'chatgpt' }
  let turnId: string | undefined
  try {
    for (let index = 1; index < argv.length; index++) {
      const key = argv[index]!
      if (key.startsWith('--')) {
        const value = argv[++index]
        if (!value) throw runtimeError('WEB_RUNTIME_ARGUMENT', `Missing value for ${key}.`)
        if (key === '--state-directory') options.stateDirectory = value
        else if (key === '--provider') options.provider = value
        else if (key === '--cdp-url') options.attachCdpUrl = value
        else if (key === '--chrome-executable') options.chromeExecutable = value
        else if (key === '--max-input-bytes') options.maxInputBytes = Number(value)
        else if (key === '--idle-timeout-ms') options.idleTimeoutMs = Number(value)
        else throw runtimeError('WEB_RUNTIME_ARGUMENT', 'Unknown runtime option.')
      } else if (turnId === undefined) turnId = key
      else throw runtimeError('WEB_RUNTIME_ARGUMENT', 'Unexpected argument.')
    }
    if (!options.stateDirectory) throw runtimeError('WEB_RUNTIME_ARGUMENT', '--state-directory is required.')
    if (command === 'daemon') {
      if (turnId !== undefined) throw runtimeError('WEB_RUNTIME_ARGUMENT', 'Daemon accepts only its private state directory.')
      const running = await startRuntimeDaemon({ stateDirectory: options.stateDirectory })
      const stop = () => { void running.close().catch(() => undefined) }
      process.once('SIGTERM', stop); process.once('SIGINT', stop)
      try { await running.closed } finally { process.off('SIGTERM', stop); process.off('SIGINT', stop) }
      return 0
    }
    const runtime = new ManagedWebRuntime(options)
    try {
      let value: unknown
      if (command === 'status') value = await runtime.status()
      else if (command === 'setup') value = await runtime.setup()
      else if (command === 'verify') value = await runtime.verify()
      else if (command === 'enable' || command === 'disable') value = await runtime.setEnabled(command === 'enable')
      else if (command === 'turns') value = await runtime.listTurns()
      else if (['inspect', 'recover', 'discard'].includes(command) && turnId !== undefined) {
        value = await (command === 'inspect' ? runtime.inspectTurn(turnId) : command === 'recover' ? runtime.recoverTurn(turnId) : runtime.discardTurn(turnId))
      } else throw runtimeError('WEB_RUNTIME_ARGUMENT', 'Unknown command or missing turn ID.')
      output(`${JSON.stringify(value, null, 2)}\n`)
      return 0
    } finally { await runtime.dispose() }
  } catch (error) {
    output(`${JSON.stringify({ error: error instanceof WebBridgeError ? error.code : 'WEB_RUNTIME_ERROR',
      message: error instanceof WebBridgeError ? error.message.slice(0, 768) : 'Runtime command failed; inspect local state.' })}\n`)
    return 1
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runWebBridgeCli()
}
