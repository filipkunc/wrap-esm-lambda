import * as babel from '@babel/core';
import { types as t } from '@babel/core';

export function transformLambda(input: string, handler: string, wrapper: string): string {
  const result = babel.transformSync(input, {
    plugins: [
      function lambdaTransform(): babel.PluginObj {
        return {
          visitor: {
            ExportNamedDeclaration(path) {
              if (t.isVariableDeclaration(path.node.declaration)) {
                const varDecl = path.node.declaration.declarations[0];
                if (t.isIdentifier(varDecl.id) && varDecl.id.name === handler) {
                  path.replaceWith(t.exportNamedDeclaration(
                    t.variableDeclaration("const", [
                      t.variableDeclarator(t.identifier(handler),
                        t.callExpression(t.identifier(wrapper),
                          [varDecl.init!]))]
                    )));
                  path.skip();
                }
              }
            }
          }
        };
      },
    ],
  });
  return result?.code ?? "";
}
