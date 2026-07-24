// Patches for names forwarded by bare-SPECIFIER stars — both rebind, the
// operation that needs the walk to find the providing package first.
export function patchStarPkg(bindings) {
  const Orig = bindings.StarPkg
  bindings.StarPkg = class extends Orig {
    greet() {
      return `starpkg:${super.greet()}`
    }
  }
}

export function patchStarPlain(bindings) {
  const orig = bindings.plainGreet
  bindings.plainGreet = (name) => `wrapped:${orig(name)}`
}
