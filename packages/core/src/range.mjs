// A small semver-range matcher replacing the `semver` package, which was
// the single biggest contributor to the runtime shell's cold start (its
// module graph costs milliseconds; matching needs microseconds of logic).
// It implements the subset of node-semver's grammar that version-gating
// configs actually use — differential-tested against the real `semver`
// package in __test__/range.spec.ts:
//
// - comparators `>=` `>` `<=` `<` `=`, bare versions, partials (`>=3`, `<5`)
// - caret `^1.2.3` (incl. the 0.x rules), tilde `~1.2.3`
// - x-ranges `1.x`, `1.2.*`, `*`, and the empty range
// - `||` alternatives and hyphen ranges `1.2 - 3`
// - v-prefixes and build metadata (`v1.2.3+build`) are accepted and ignored
// - npm's prerelease gating: `1.2.3-beta` only satisfies a range naming a
//   prerelease on the same `[major, minor, patch]` tuple
//
// One deliberate difference from node-semver: an unparseable RANGE throws a
// TypeError instead of silently matching nothing. A typo'd `versionRange`
// would otherwise mean silently-missing instrumentation — the failure mode
// this project always makes loud. An unparseable VERSION (a package.json
// with a nonsense version field) still just fails to match, like semver.

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/
const PARTIAL_RE =
  /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/
const NUMERIC_RE = /^\d+$/

/** @returns {{ major: number, minor: number, patch: number, prerelease: string[] } | null} */
export function parseVersion(text) {
  const m = VERSION_RE.exec(String(text).trim())
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], prerelease: m[4] ? m[4].split('.') : [] }
}

/** Semver precedence for prerelease identifier lists; [] means a release. */
function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1 // a release outranks any prerelease
  if (b.length === 0) return -1
  for (let i = 0; ; i += 1) {
    if (i >= a.length && i >= b.length) return 0
    if (i >= a.length) return -1 // shorter prefix is smaller
    if (i >= b.length) return 1
    const idA = a[i]
    const idB = b[i]
    if (idA === idB) continue
    const numA = NUMERIC_RE.test(idA)
    const numB = NUMERIC_RE.test(idB)
    if (numA && numB) return +idA - +idB
    if (numA) return -1 // numeric identifiers sort below alphanumeric
    if (numB) return 1
    return idA < idB ? -1 : 1
  }
}

function compareVersions(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch || comparePrerelease(a.prerelease, b.prerelease)
}

const version = (major, minor, patch, prerelease = []) => ({ major, minor, patch, prerelease })
const cmp = (op, ver) => ({ op, ver })

function invalid(range) {
  throw new TypeError(
    `invalid version range '${range}' — supported: comparators (>=, >, <=, <, =), ^, ~, x-ranges, '||' and hyphen ranges`,
  )
}

/** A partial like `1`, `1.2`, `1.2.3-rc.1`, `1.x`, `*` — wildcards become null. */
function parsePartial(text, range) {
  const m = PARTIAL_RE.exec(text)
  if (!m) invalid(range)
  const part = (raw) => (raw === undefined || raw === 'x' || raw === 'X' || raw === '*' ? null : +raw)
  return { major: part(m[1]), minor: part(m[2]), patch: part(m[3]), prerelease: m[4] ? m[4].split('.') : [] }
}

/** Comparators for one caret token, mirroring node-semver's rules. */
function caretComparators(p) {
  if (p.major === null) return []
  if (p.minor === null) return [cmp('>=', version(p.major, 0, 0)), cmp('<', version(p.major + 1, 0, 0))]
  if (p.patch === null) {
    return p.major === 0
      ? [cmp('>=', version(0, p.minor, 0)), cmp('<', version(0, p.minor + 1, 0))]
      : [cmp('>=', version(p.major, p.minor, 0)), cmp('<', version(p.major + 1, 0, 0))]
  }
  const lower = cmp('>=', version(p.major, p.minor, p.patch, p.prerelease))
  if (p.major > 0) return [lower, cmp('<', version(p.major + 1, 0, 0))]
  if (p.minor > 0) return [lower, cmp('<', version(0, p.minor + 1, 0))]
  return [lower, cmp('<', version(0, 0, p.patch + 1))]
}

/** Comparators for one tilde token. */
function tildeComparators(p) {
  if (p.major === null) return []
  if (p.minor === null) return [cmp('>=', version(p.major, 0, 0)), cmp('<', version(p.major + 1, 0, 0))]
  const patch = p.patch ?? 0
  return [cmp('>=', version(p.major, p.minor, patch, p.prerelease)), cmp('<', version(p.major, p.minor + 1, 0))]
}

/** Comparators for `[op]partial`; bare partials are x-ranges/exact pins. */
function operatorComparators(op, p, range) {
  if (op === '' || op === '=') {
    if (p.major === null) return []
    if (p.minor === null) return [cmp('>=', version(p.major, 0, 0)), cmp('<', version(p.major + 1, 0, 0))]
    if (p.patch === null) {
      return [cmp('>=', version(p.major, p.minor, 0)), cmp('<', version(p.major, p.minor + 1, 0))]
    }
    return [cmp('=', version(p.major, p.minor, p.patch, p.prerelease))]
  }
  if (p.major === null) {
    // `>*` / `<*` match nothing; `>=*` / `<=*` match everything
    return op === '>' || op === '<' ? [cmp('<', version(0, 0, 0))] : []
  }
  if (op === '>') {
    if (p.minor === null) return [cmp('>=', version(p.major + 1, 0, 0))]
    if (p.patch === null) return [cmp('>=', version(p.major, p.minor + 1, 0))]
    return [cmp('>', version(p.major, p.minor, p.patch, p.prerelease))]
  }
  if (op === '>=') {
    return [cmp('>=', version(p.major, p.minor ?? 0, p.patch ?? 0, p.prerelease))]
  }
  if (op === '<') {
    return [cmp('<', version(p.major, p.minor ?? 0, p.patch ?? 0, p.prerelease))]
  }
  if (op === '<=') {
    if (p.minor === null) return [cmp('<', version(p.major + 1, 0, 0))]
    if (p.patch === null) return [cmp('<', version(p.major, p.minor + 1, 0))]
    return [cmp('<=', version(p.major, p.minor, p.patch, p.prerelease))]
  }
  invalid(range)
}

/** One `||` alternative -> its AND-ed comparator list. */
function parseComparatorSet(set, range) {
  const comparators = []
  const hyphen = set.split(/\s+-\s+/)
  if (hyphen.length > 2) invalid(range)
  if (hyphen.length === 2) {
    const lo = parsePartial(hyphen[0], range)
    const hi = parsePartial(hyphen[1], range)
    if (lo.major !== null) comparators.push(cmp('>=', version(lo.major, lo.minor ?? 0, lo.patch ?? 0, lo.prerelease)))
    if (hi.major !== null) {
      if (hi.minor === null) comparators.push(cmp('<', version(hi.major + 1, 0, 0)))
      else if (hi.patch === null) comparators.push(cmp('<', version(hi.major, hi.minor + 1, 0)))
      else comparators.push(cmp('<=', version(hi.major, hi.minor, hi.patch, hi.prerelease)))
    }
    return comparators
  }
  // tokens: an operator may be separated from its version by spaces (">= 1.2")
  const tokens = set.split(/\s+/).filter(Boolean)
  for (let i = 0; i < tokens.length; i += 1) {
    let token = tokens[i]
    let op = ''
    const m = /^(>=|<=|>|<|=|\^|~)/.exec(token)
    if (m) {
      op = m[1]
      token = token.slice(op.length)
      if (token === '' && i + 1 < tokens.length) token = tokens[(i += 1)]
      if (token === '') invalid(range)
    }
    const partial = parsePartial(token, range)
    if (op === '^') comparators.push(...caretComparators(partial))
    else if (op === '~') comparators.push(...tildeComparators(partial))
    else comparators.push(...operatorComparators(op, partial, range))
  }
  return comparators
}

/** range string -> comparator sets (one per `||` alternative), memoized. */
const rangeCache = new Map()

function parseRange(range) {
  let sets = rangeCache.get(range)
  if (sets === undefined) {
    sets = String(range)
      .split('||')
      .map((set) => parseComparatorSet(set.trim(), range))
    rangeCache.set(range, sets)
  }
  return sets
}

function testComparator(v, { op, ver }) {
  const order = compareVersions(v, ver)
  if (op === '>') return order > 0
  if (op === '>=') return order >= 0
  if (op === '<') return order < 0
  if (op === '<=') return order <= 0
  return order === 0
}

function testSet(v, comparators) {
  if (!comparators.every((comparator) => testComparator(v, comparator))) return false
  if (v.prerelease.length > 0) {
    // npm's gating rule: a prerelease version only satisfies a set that
    // names a prerelease on the same [major, minor, patch] tuple
    return comparators.some(
      ({ ver }) => ver.prerelease.length > 0 && ver.major === v.major && ver.minor === v.minor && ver.patch === v.patch,
    )
  }
  return true
}

/**
 * Does `versionText` satisfy `range`? The drop-in for `semver.satisfies`,
 * except an invalid range throws instead of silently matching nothing.
 */
export function satisfies(versionText, range) {
  const v = parseVersion(versionText)
  if (v === null) return false
  return parseRange(range).some((set) => testSet(v, set))
}
