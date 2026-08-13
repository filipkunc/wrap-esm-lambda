import { stripTypeScriptTypes } from 'node:module'

export function isTypeScriptFilename(filename: string | undefined | null): filename is string {
  return filename != null && /\.(?:[cm]?ts|tsx)$/.test(filename)
}

export function stripTypeScript(input: string): string {
  // Erasable syntax becomes whitespace, preserving positions without a map.
  // Generated forms such as enums remain an explicit Acorn limitation.
  return stripTypeScriptTypes(input, { mode: 'strip' })
}
