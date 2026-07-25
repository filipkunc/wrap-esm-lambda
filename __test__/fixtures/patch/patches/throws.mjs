// A patch function with a bug in it: the runtime shell must contain the throw
// so the module being patched still loads (and the app still starts).
export function patchThatThrows() {
  throw new Error('patch code is broken')
}
