import * as acorn from "acorn";
import * as estraverse from "estraverse";
import * as ESTree from "estree";
import * as NESTree from "node-estree";
import * as astring from "astring";

export function transformLambda(code: string, handler: string, wrapper: string): string {
  const ast = acorn.parse(code, { ecmaVersion: 2020, sourceType: "module" });

  estraverse.replace(ast as ESTree.Node, {
    enter: function (node) {
      if (node.type === "ExportNamedDeclaration" && node.declaration?.type === "VariableDeclaration") {
        const varDecl = node.declaration.declarations[0];
        if (varDecl.id.type === "Identifier" && varDecl.id.name === handler) {
          varDecl.init = NESTree.ESTree.CallExpression(NESTree.Helpers.AutoChain(wrapper),
            [varDecl.init as NESTree.ESTree.Expression]) as ESTree.Expression;
        }
        return { ...node };
      }
    }
  });

  return astring.generate(ast);
}
