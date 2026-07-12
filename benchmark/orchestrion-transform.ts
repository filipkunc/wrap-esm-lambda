import { create } from '@apm-js-collab/code-transformer'
import type { Node } from 'estree'

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
minimal.matcher.addTransform('minimal-wrap', (_state: unknown, node: Node) => {
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
})

export function transformLambdaMinimal(code: string): string {
  return minimal.transformer.transform(code, 'esm').code
}
