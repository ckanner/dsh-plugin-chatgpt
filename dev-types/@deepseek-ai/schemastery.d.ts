/**
 * Development-only declaration for the harness's configuration validator.
 *
 * Transcribed from the API this plugin uses, which is the subset every DSH
 * package declares its `Config` with. Not published; the host supplies the real
 * package at runtime, and a `Config` schema is also what gives a plugin a
 * settings namespace — the Models page will not show a provider row for a
 * plugin whose namespace does not exist.
 *
 * @module dsh-plugin-chatgpt/dev-types/schemastery
 */

declare module '@deepseek-ai/schemastery' {
  /**
   * A live accessor a `volatile()` field resolves to.
   *
   * The harness keeps these values in the settings document rather than in the
   * deployment patch, so they are read through `get()` at the moment they are
   * used instead of being captured as a plain value.
   */
  export interface Volatile<T> {
    /** The current value, absent when nothing supplies one. */
    get(): T | undefined
  }

  /** A validated field or object schema. */
  export interface Schema<T = unknown> {
    /** Mark the field as required. */
    required(): Schema<T>
    /** Supply a default for an omitted field. */
    default(value: T): Schema<T>
    /**
     * Read the field through a live accessor and keep it in the settings
     * document rather than the deployment patch. The harness builds its settings
     * form from exactly these fields, so a plugin with none has no settings
     * namespace — and a provider row that cannot be rendered.
     */
    volatile(): Schema<Volatile<T>>
    /** JSON Schema projection, read by the settings surface. */
    toJSON(): unknown
  }

  /** The schema builders this plugin uses. */
  export interface Schemastery {
    /** A UTF-8 string field. */
    string(): Schema<string>
    /** A boolean field. */
    boolean(): Schema<boolean>
    /** An object whose declared fields compose the schema. */
    object<T extends object>(fields: { [K in keyof T]: Schema<T[K]> }): Schema<T> & { toJSON(): unknown }
  }

  const z: Schemastery
  export default z
}
