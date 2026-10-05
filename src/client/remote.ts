/**
 * Mounting this plugin's own Client Remote namespace.
 *
 * The Gateway installs a client namespace from a contribution of generated
 * descriptors, and the package carrying those for the shipped API packages is
 * generated at build time from a fixed list of workspace packages. Nothing
 * generates one for an out-of-tree plugin, so the card would find no
 * `ctx.remote.chatgpt` however long it waited. This mounts the missing piece.
 *
 * Two validators read these descriptors and they ask for different things, which
 * is the whole difficulty of hand-writing them: the Gateway requires a `strict`
 * codec on every parameter and never calls it, while the Typert registry requires
 * that a `strict` codec also name a type symbol and provide a `create()` factory,
 * accepting `src-json` as an alternative that needs neither. Parameters satisfy
 * the first with the second's demands attached; the result is `src-json`, which
 * both accept. The codec bodies never run on this side — the declared names are
 * what the Host matches on.
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

/** How the Host receives a result this side does not need to decode. */
const RESULT_CODEC = { mode: 'src-json' as const }

/**
 * A codec both validators accept, for one argument.
 *
 * `create` is never invoked on this side — the Gateway builds calls from the
 * declared wire names and sends JSON — so it returns a permissive parser rather
 * than a false claim about a schema this plugin has no way to express.
 *
 * @param typeSymbol - the name the registry records for this argument's type.
 * @returns the codec.
 */
function parameterCodec(typeSymbol: string): { mode: 'strict', typeSymbol: string, create: () => unknown } {
  return {
    mode: 'strict',
    typeSymbol,
    create: () => ({ parse: (value: unknown) => value }),
  }
}

/** A descriptor as far as both validators and the client's call path read it. */
interface RemoteDescriptor {
  id: string
  service: string
  namespace: string
  method: string
  invocation: { kind: 'direct' }
  parameters: {
    name: string
    wire: string
    source: 'json'
    codec: { mode: 'strict', typeSymbol: string, create: () => unknown }
    /** Present when the Host declares the argument optional. */
    acceptsUndefined?: true
  }[]
  /**
   * `src-json` rather than `strict`: the registry exempts it from the type symbol
   * and factory a strict codec must carry, and the Gateway does not inspect the
   * result codec at all. The caller receives the Host's value unchanged.
   */
  result: { mode: 'src-json' }
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
      parameters: parameters.map(({ wire, optional }) => ({
        name: wire,
        wire,
        source: 'json' as const,
        codec: parameterCodec(`${PACKAGE}#${REMOTE_NAMESPACE}/${method}:${wire}`),
        ...optional === true ? { acceptsUndefined: true as const } : {},
      })),
      result: RESULT_CODEC,
      // Pointed at the declaration the descriptor mirrors, so a diagnostic from the
      // Gateway leads to the method it is really about.
      sourceLocation: { file: 'src/controller.ts', line: 1, column: 1 },
    })),
  }
}
