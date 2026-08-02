// The probe drivers' shared reporting: patches bump a well-known global
// counter (see ../patches/bump.mts); the driver asserts its scenario worked
// AND the counter moved, then prints the one-line verdict the runner reads.
const KEY = Symbol.for('wrap-esm-lambda-corpus.probe')

export function probeCount(): number {
  return ((globalThis as Record<symbol, unknown>)[KEY] as number | undefined) ?? 0
}

export function report(ok: boolean, detail = ''): void {
  const count = probeCount()
  console.log(ok && count > 0 ? 'PROBE:OK' : `PROBE:FAIL count=${count}${detail ? ` ${detail}` : ''}`)
}
