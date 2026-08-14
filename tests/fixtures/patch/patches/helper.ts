// A relative TypeScript dependency of a patch module — proves the patch's own
// module graph resolves in both delivery modes.
export function exclaim(value: string): string {
  return `${value}!`
}
