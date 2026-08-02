// The SSR probe page: getServerSideProps runs in the Next SERVER process on
// every request and calls `ms` — an ordinary externalized node_modules
// dependency, required at runtime, which is exactly where the runtime hook
// (delivered via NODE_OPTIONS) reaches. The page renders both the wrapped
// call's result and the patch counter, so the harness asserts from plain
// HTML that the patched dependency served the server-rendered request.
// Plain .jsx on purpose: a .tsx page would make `next build` auto-provision
// a tsconfig and mutate the fixture.
import ms from 'ms'

export function getServerSideProps() {
  const value = ms(120000)
  const taps = globalThis[Symbol.for('wrap-esm-lambda-corpus.probe')] ?? 0
  return { props: { value, taps } }
}

export default function Ssr({ value, taps }) {
  return <main id="probe">{`ssr:${taps}:${value}`}</main>
}
