export function transformLambda(input: string, handler: string, wrapper: string): string {
  const exportNamedDecl = `export const ${handler}`;
  const origHandler = `orig_${handler}`;
    if (input.includes(exportNamedDecl)) {
        let transformed = input.replace(exportNamedDecl, `const ${origHandler}`);
        transformed += `\n${exportNamedDecl} = ${wrapper}(${origHandler});`;
        return transformed;
    }
    return input;
}
