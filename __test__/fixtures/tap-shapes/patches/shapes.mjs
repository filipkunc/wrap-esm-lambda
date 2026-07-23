// One patch per export shape the rewrite path unlocks — each REBINDS the
// export, the operation a pure append could never offer these shapes.

export function patchConstHandler(bindings) {
  const orig = bindings.handler
  bindings.handler = async (event) => `wrapped:${await orig(event)}`
}

export function patchDefault(bindings) {
  const orig = bindings.default
  bindings.default = async (event) => `wrapped:${await orig(event)}`
}

export function patchBarrel(bindings) {
  const Orig = bindings.Inner
  bindings.Inner = class extends Orig {
    greet() {
      return `patched:${super.greet()}`
    }
  }
}
