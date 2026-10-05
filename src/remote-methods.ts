/**
 * The Remote surface, described once for both halves.
 *
 * A bundled third-party plugin cannot reach `ctx.remote.<namespace>` on its own.
 * The Gateway installs a client namespace only from a *contribution* of generated
 * descriptors, and the package that carries those for the shipped API packages —
 * `@deepseek-ai/dsh-api-remotes` — is generated at build time from a fixed list of
 * workspace packages. Nothing runs the generator for an out-of-tree package, and
 * its published face is not usable from one, so a plugin that wants a card has to
 * mount its own contribution.
 *
 * That is what happens here, and this table is the part worth keeping in one
 * place: the client builds its descriptors from it and a test checks it against
 * the decorated methods on {@link ChatGptController}, because a method added to
 * the Host and forgotten here would fail only at the moment a user clicks.
 *
 * @module dsh-plugin-chatgpt/remote-methods
 */

/** One argument of a Remote method. */
export interface RemoteParameter {
  /** Wire name, which the Gateway builds the call from. */
  wire: string
  /**
   * Whether the Host declares this argument optional.
   *
   * The Gateway counts arguments exactly, so an optional argument is still sent —
   * as an explicit `undefined` — and the descriptor says so with `acceptsUndefined`.
   * Declaring it required instead makes every call that omits it fail with
   * "expected 1 argument(s), got 0".
   */
  optional?: boolean
}

/** One method the Host exposes, with the wire name of each argument. */
export interface RemoteMethod {
  /** Method name on the controller. */
  method: string
  /** Arguments, in call order. */
  parameters: readonly RemoteParameter[]
}

/**
 * Every method the card may call.
 *
 * Order is the declaration order on the controller, which nothing depends on, but
 * keeping it the same makes the two lists easy to compare by eye as well as by
 * test.
 */
export const REMOTE_METHODS: readonly RemoteMethod[] = [
  { method: 'status', parameters: [] },
  { method: 'begin', parameters: [] },
  { method: 'submit', parameters: [{ wire: 'value' }] },
  { method: 'cancel', parameters: [] },
  { method: 'signOut', parameters: [{ wire: 'subject', optional: true }] },
]

/** The Cordis service key the controller registers, and the descriptor's service field. */
export const REMOTE_SERVICE_KEY = 'chatgptController'

/** The wire namespace both halves address this surface by. */
export const REMOTE_NAMESPACE = 'chatgpt'
