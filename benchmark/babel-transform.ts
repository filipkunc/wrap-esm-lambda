import * as babel from '@babel/core';
import { types as t } from '@babel/core';

function origHandler(origHandlerName: string, initExpr: t.Expression): t.VariableDeclaration {
  return t.variableDeclaration("const", [
    t.variableDeclarator(t.identifier(origHandlerName), initExpr)]);
}

function wrapHandler(handler: string, origHandler: string, wrapper: string): t.ExportNamedDeclaration {
  return t.exportNamedDeclaration(
    t.variableDeclaration("const", [
      t.variableDeclarator(t.identifier(handler),
        t.callExpression(t.identifier(wrapper),
          [t.identifier(origHandler)]))]
    )
  );
}

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
                  const origHandlerName = `orig_${handler}`;
                  path.insertBefore(origHandler(origHandlerName, varDecl.init!));
                  path.replaceWith(wrapHandler(handler, origHandlerName, wrapper));
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
