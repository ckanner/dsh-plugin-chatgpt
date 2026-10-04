/**
 * Mounting this plugin's own Client Remote namespace.
 *
 * The Gateway installs a client namespace from a contribution of generated
 * descriptors, and the package carrying those for the shipped API packages is
 * generated at build time from a fixed list of workspace packages. Nothing
 * generates one for an out-of-tree plugin, so the card would find no
 * `ctx.remote.chatgpt` however long it waited. This mounts the missing piece.
 *
 * The descriptors are small because the client reads very little of them: it
 * checks that every parameter declares a strict codec, then builds the call from
 * the declared wire names and sends it as JSON. It never invokes the codec, and it
 * decodes a result only through an optional `decode` this omits. So the fields
 * that would otherwise be generated schemas only have to be present and honest
 * about their shape — the names in them are what the Host actually matches on.
 *
 * @module dsh-plugin-chatgpt/client/remote
 */

import {
  REMOTE_METHODS,
  REMOTE_NAMESPACE,
  REMOTE_SERVICE_KEY,
} from '../remote-methods.ts'

/** The package name the mount is attributed to, as the Gateway records it. */
const PACKAGE = 'dsh-plugin-chatgpt'

/** The strict codec marker the client insists on and never calls. */
const STRICT_CODEC = { mode: 'strict' as const }

/** A descriptor as far as the client's validation and call path read it. */
interface RemoteDescriptor {
  id: string
  service: string
  namespace: string
  method: string
  invocation: { kind: 'direct' }
  parameters: { name: string, wire: string, source: 'json', codec: { mode: 'strict' } }[]
  result: { mode: 'strict' }
  sourceLocation: { file: string, line: number, column: number }
}

/** A contribution of one package's descriptors. */
export interface RemoteContribution {
  package: string
  descriptors: RemoteDescriptor[]
}

/**
 * The contribution this plugin mounts.
 * @returns the descriptors, one per exposed method.
 */
export function remoteContribution(): RemoteContribution {
  return {
    package: PACKAGE,
    descriptors: REMOTE_METHODS.map(({ method, parameters }) => ({
      id: `${PACKAGE}#${REMOTE_NAMESPACE}/${method}`,
      service: REMOTE_SERVICE_KEY,
      namespace: REMOTE_NAMESPACE,
      method,
      invocation: { kind: 'direct' as const },
      parameters: parameters.map(wire => ({ name: wire, wire, source: 'json' as const, codec: STRICT_CODEC })),
      result: STRICT_CODEC,
      // Pointed at the declaration the descriptor mirrors, so a diagnostic from the
      // Gateway leads to the method it is really about.
      sourceLocation: { file: 'src/controller.ts', line: 1, column: 1 },
    })),
  }
}
