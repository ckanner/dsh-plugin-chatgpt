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

/** One method the Host exposes, with the wire name of each argument. */
export interface RemoteMethod {
  /** Method name on the controller. */
  method: string
  /**
   * Argument wire names, in call order.
   *
   * The Gateway builds a call from the declared names, so each one has to match
   * the parameter it carries on the Host side.
   */
  parameters: readonly string[]
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
  { method: 'submit', parameters: ['value'] },
  { method: 'cancel', parameters: [] },
  { method: 'signOut', parameters: ['subject'] },
]

/** The Cordis service key the controller registers, and the descriptor's service field. */
export const REMOTE_SERVICE_KEY = 'chatgptController'

/** The wire namespace both halves address this surface by. */
export const REMOTE_NAMESPACE = 'chatgpt'
