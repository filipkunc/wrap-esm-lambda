export function transformLambda(input: string, handler: string, wrapper: string): string {
  return input.replace(
    new RegExp(`export const ${handler} = (.+);`, "s"),
    `export const ${handler} = ${wrapper}($1);`
  );
}
