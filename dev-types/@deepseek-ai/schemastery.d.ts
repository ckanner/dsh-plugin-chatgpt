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
  /** A validated field or object schema. */
  export interface Schema<T = unknown> {
    /** Mark the field as required. */
    required(): Schema<T>
    /** Supply a default for an omitted field. */
    default(value: T): Schema<T>
    /**
     * Exclude the field from persisted settings writes, so a deployment-supplied
     * value is not copied into the user's document.
     */
    volatile(): Schema<T>
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
