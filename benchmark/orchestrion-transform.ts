import { create } from '@apm-js-collab/code-transformer'
import type { Node } from 'estree'
import { createRequire } from 'node:module'

// Resolve the *same* esquery module instance orchestrion loads internally, so a
// patch here reaches its `esquery.parse` call in transformer.js.
const localRequire = createRequire(import.meta.url)
const octRequire = createRequire(localRequire.resolve('@apm-js-collab/code-transformer'))
const esquery = octRequire('esquery') as {
  parse: (selector: string) => unknown
  traverse: (...args: unknown[]) => void
}

function minimalWrap(_state: unknown, node: Node): void {
  const wrapped = { ...node } as Node
  for (const key of Object.keys(node)) {
    delete (node as unknown as Record<string, unknown>)[key]
  }
  Object.assign(node, {
    type: 'CallExpression',
    callee: { type: 'Identifier', name: 'wrapper' },
    arguments: [wrapped],
    optional: false,
  })
}

function createTransformer(handler: string, customTransform?: string) {
  const matcher = create([
    {
      channelName: 'lambda-handler',
      module: { name: 'runtime', versionRange: '>=0.0.0', filePath: 'runtime.mjs' },
      functionQuery: { expressionName: handler, kind: 'Async' },
      ...(customTransform ? { transform: customTransform } : {}),
    },
  ])
  return { matcher, transformer: matcher.getTransformer('runtime', '1.0.0', 'runtime.mjs')! }
}

// Default orchestrion output: full diagnostics_channel tracing wrapper.
const tracing = createTransformer('handler')

export function transformLambdaTracing(code: string): string {
  return tracing.transformer.transform(code, 'esm').code
}

// Custom transform producing the same minimal `wrapper(...)` call as the
// oxc/babel/acorn/swc implementations, for an apples-to-apples comparison.
const minimal = createTransformer('handler', 'minimal-wrap')
minimal.matcher.addTransform('minimal-wrap', minimalWrap)

export function transformLambdaMinimal(code: string): string {
  return minimal.transformer.transform(code, 'esm').code
}

// Same as `transformLambdaMinimal`, but with orchestrion's per-call
// `esquery.parse(selector)` memoized. transformer.js recompiles the selector
// string on every `transform()`; that compile is the single biggest cost for a
// tiny input. We cache it (keyed by selector) only for the duration of these
// calls, restoring the original parse afterwards so the uncached bar in the same
// process stays an honest baseline.
const minimalCached = createTransformer('handler', 'minimal-wrap')
minimalCached.matcher.addTransform('minimal-wrap', minimalWrap)

const parseCache = new Map<string, unknown>()
const originalParse = esquery.parse
const cachedParse = (selector: string): unknown => {
  let parsed = parseCache.get(selector)
  if (parsed === undefined) {
    parsed = originalParse(selector)
    parseCache.set(selector, parsed)
  }
  return parsed
}

export function transformLambdaMinimalCached(code: string): string {
  esquery.parse = cachedParse
  try {
    return minimalCached.transformer.transform(code, 'esm').code
  } finally {
    esquery.parse = originalParse
  }
}
