import * as acorn from 'acorn'
import * as estraverse from 'estraverse'
import type * as ESTree from 'estree'
import { ESTree as NESTree, Helpers } from 'node-estree'
import * as astring from 'astring'
import { createRequire } from 'node:module'

// astring's `sourceMap` option wants a classic `SourceMapGenerator` (an
// `.addMapping()` method + a readable `.file`). `@jridgewell/source-map` is the
// synchronous drop-in; require it to avoid ESM default-interop typing friction.
type Mapping = { original: unknown; generated: unknown; name?: string; source?: string }
interface JridgewellGenerator {
  file?: string
  addMapping(mapping: Mapping): void
  setSourceContent(source: string, content: string): void
  toString(): string
}
const { SourceMapGenerator } = createRequire(import.meta.url)('@jridgewell/source-map') as {
  SourceMapGenerator: new (opts: { file: string }) => JridgewellGenerator
}

// Wrap the handler (acorn parse + estraverse) and emit an inline source map with
// astring feeding a @jridgewell/source-map generator, mirroring oxc's inline map.
export function transformAcornInlineMap(code: string, handler: string, wrapper: string, filename: string): string {
  const ast = acorn.parse(code, { ecmaVersion: 2020, sourceType: 'module', locations: true, sourceFile: filename })

  estraverse.replace(ast as ESTree.Node, {
    enter(node) {
      if (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'VariableDeclaration') {
        const varDecl = node.declaration.declarations[0]
        if (varDecl.id.type === 'Identifier' && varDecl.id.name === handler) {
          varDecl.init = NESTree.CallExpression(Helpers.AutoChain(wrapper), [
            varDecl.init as NESTree.Expression,
          ]) as ESTree.Expression
        }
        return { ...node }
      }
      return undefined
    },
  })

  const map = new SourceMapGenerator({ file: filename })
  map.file = filename // astring reads `.file` as the mapping's source name
  map.setSourceContent(filename, code)
  // astring's types want a classic `source-map` generator; at runtime it only
  // calls `.addMapping()` and reads `.file`, which the @jridgewell one provides.
  const options = { sourceMap: map } as unknown as Parameters<typeof astring.generate>[1]
  const generated = astring.generate(ast as ESTree.Node, options)
  const base64 = Buffer.from(map.toString(), 'utf8').toString('base64')
  return `${generated}\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${base64}\n`
}
