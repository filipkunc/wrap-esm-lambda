import test from 'ava'
import semver from 'semver'

// The mini range parser must agree with the real `semver` package on the
// grammar subset it claims — differential-tested pair by pair. It replaced
// semver in @wrap-esm-lambda/core because the package's module graph
// dominated the runtime shell's cold start.

// @ts-expect-error untyped workspace module
const { satisfies, parseVersion } = await import('@wrap-esm-lambda/core/range')

const VERSIONS = [
  '0.0.1',
  '0.2.3',
  '0.2.9',
  '0.3.0',
  '1.0.0',
  '1.2.0',
  '1.2.3',
  '1.2.4',
  '1.3.0',
  '2.0.0',
  '2.0.1',
  '3.0.0',
  '3.29.5',
  '4.2.0',
  '4.9.9',
  '5.0.0',
  '5.2.1',
  '6.0.0',
  '22.15.0',
  '22.22.3',
  '24.11.1',
  '1.0.0-alpha',
  '1.0.0-alpha.1',
  '1.0.0-alpha.beta',
  '1.0.0-beta.2',
  '1.0.0-beta.11',
  '1.0.0-rc.1',
  '2.0.0-0',
  '5.0.0-beta',
  'v1.2.3',
  '1.2.3+build.7',
]

const RANGES = [
  // the shapes this repo's configs actually use
  '>=3 <5',
  '>=5 <6',
  '>=1 <2',
  '>=4 <5',
  '>=22',
  '<20',
  '>=9',
  '>=0',
  // comparators and partials
  '>1.2.3',
  '>=1.2.3',
  '<1.2.3',
  '<=1.2.3',
  '=1.2.3',
  '1.2.3',
  '>1',
  '>1.2',
  '<=1',
  '<=1.2',
  '>= 1.2.3 < 2',
  // caret, incl. the 0.x special cases
  '^1.2.3',
  '^0.2.3',
  '^0.0.1',
  '^1.2',
  '^0.2',
  '^1',
  // tilde
  '~1.2.3',
  '~1.2',
  '~1',
  '~0.2.3',
  // x-ranges and wildcards
  '1.x',
  '1.2.x',
  '1.2.*',
  '*',
  '',
  '2',
  '2.0',
  // alternatives and hyphen ranges
  '1.2.3 || 2.x',
  '<1 || >=5 <6',
  '1.2.3 - 2.3.4',
  '1.2 - 2',
  // prerelease-including ranges (gating rule)
  '>=1.0.0-alpha <2',
  '>=1.0.0-beta.2 <1.0.1',
  '^1.0.0-alpha',
]

test('differential: satisfies() agrees with the semver package across the grammar', (t) => {
  for (const range of RANGES) {
    for (const version of VERSIONS) {
      const expected = semver.satisfies(version, range)
      const actual = satisfies(version, range)
      t.is(actual, expected, `satisfies('${version}', '${range}') must be ${expected}`)
    }
  }
})

test('an invalid range throws loudly instead of silently matching nothing', (t) => {
  for (const bad of ['not a range', '>=x.y.z', '1.2.3 - 2 - 3', '>>1.0.0']) {
    const err = t.throws(() => satisfies('1.0.0', bad))
    t.regex(err!.message, /invalid version range/, `'${bad}' must be rejected loudly`)
  }
})

test('an invalid version fails to match, like semver', (t) => {
  for (const bad of ['garbage', '1.2', '1.2.3.4', '']) {
    t.is(satisfies(bad, '>=0'), false)
    t.is(satisfies(bad, '>=0'), semver.satisfies(bad, '>=0'))
  }
})

test('parseVersion handles v-prefix, prerelease and build metadata', (t) => {
  t.deepEqual(parseVersion('v1.2.3-rc.1+build.5'), { major: 1, minor: 2, patch: 3, prerelease: ['rc', '1'] })
  t.is(parseVersion('nope'), null)
})
