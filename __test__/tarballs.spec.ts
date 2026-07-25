import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// What a consumer actually receives. Everything else in this suite runs the
// packages out of the workspace, where `files`, `exports` and `bin` are never
// consulted — so a manifest that points at something the tarball does not ship
// would pass every other spec and break on first install.
//
// This packs each package for real (`pnpm pack`, which runs `prepack` and
// rewrites the `workspace:` protocol the way publishing would), then assembles
// an app whose node_modules contains ONLY the unpacked tarballs plus the
// third-party dependencies they declare, and runs instrumentation through it.
// No registry, so it works offline and in every lane; the engine is named
// explicitly because the native addon is not part of what is being packed here.

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const PACKAGES = ['core', 'engine-acorn', 'hooks', 'unplugin'] as const
/**
 * Third-party runtime deps of the packed packages, and which package declares
 * each: under pnpm's strict layout a dependency lives next to its dependent,
 * not at the repo root, so each has to be resolved from the right place.
 */
const THIRD_PARTY: [dep: string, declaredBy: string][] = [
  ['acorn', 'engine-acorn'],
  ['magic-string', 'engine-acorn'],
  ['@jridgewell/remapping', 'engine-acorn'],
  ['unplugin', 'unplugin'],
]

/**
 * The real directory of an installed package — inside pnpm's store, not the
 * symlink farm. Linking the real path matters: Node resolves a symlinked
 * module to its real location and looks for that module's own dependencies
 * there, which is exactly where pnpm put them, so the transitive graph comes
 * along for free.
 */
function realPackageDir(dep: string, declaredBy: string): string {
  const from = createRequire(join(repoRoot, 'packages', declaredBy, 'noop.js'))
  let dir = dirname(from.resolve(dep))
  for (;;) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      const { name } = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }
      if (name === dep) return dir
    }
    const parent = dirname(dir)
    assert.notStrictEqual(parent, dir, `could not locate ${dep} from packages/${declaredBy}`)
    dir = parent
  }
}

interface Manifest {
  name: string
  bin?: Record<string, string>
  exports?: Record<string, { types?: string; default?: string }>
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

async function packAll(dest: string): Promise<Map<string, string>> {
  const tarballs = new Map<string, string>()
  for (const pkg of PACKAGES) {
    const { stdout } = await execFileAsync('pnpm', ['pack', '--pack-destination', dest], {
      cwd: join(repoRoot, 'packages', pkg),
    })
    const tgz = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.endsWith('.tgz'))
      .at(-1)
    assert.ok(tgz, `pnpm pack printed no tarball path for ${pkg}`)
    tarballs.set(pkg, tgz)
  }
  return tarballs
}

/** Extract `package/` from a tarball into `into`. */
async function extract(tgz: string, into: string): Promise<void> {
  await mkdir(into, { recursive: true })
  await execFileAsync('tar', ['-xzf', tgz, '-C', into, '--strip-components=1'])
}

test('every path a manifest promises is inside the tarball', async () => {
  const dest = await mkdtemp(join(tmpdir(), 'wrap-esm-lambda-pack-'))
  try {
    const tarballs = await packAll(dest)
    for (const [pkg, tgz] of tarballs) {
      const root = join(dest, `unpacked-${pkg}`)
      await extract(tgz, root)
      const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Manifest

      for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
        for (const [condition, file] of Object.entries(target)) {
          assert.ok(
            existsSync(join(root, file)),
            `${manifest.name}: exports["${subpath}"].${condition} -> ${file} is not in the tarball`,
          )
        }
      }
      for (const [command, file] of Object.entries(manifest.bin ?? {})) {
        assert.ok(existsSync(join(root, file)), `${manifest.name}: bin.${command} -> ${file} is not in the tarball`)
      }

      // publishing must resolve the workspace protocol; a tarball carrying
      // `workspace:^` installs nowhere
      const deps = { ...manifest.dependencies, ...manifest.optionalDependencies }
      for (const [name, range] of Object.entries(deps)) {
        assert.ok(!range.startsWith('workspace:'), `${manifest.name}: ${name} still says ${range}`)
      }
    }
  } finally {
    await rm(dest, { recursive: true, force: true })
  }
})

test('an app installed from the tarballs alone instruments a package', async () => {
  const dest = await mkdtemp(join(tmpdir(), 'wrap-esm-lambda-install-'))
  try {
    const tarballs = await packAll(dest)
    const app = join(dest, 'app')
    const modules = join(app, 'node_modules')
    await mkdir(join(modules, '@wrap-esm-lambda'), { recursive: true })

    // the packed packages, and nothing else of ours
    for (const [pkg, tgz] of tarballs) {
      await extract(tgz, join(modules, '@wrap-esm-lambda', pkg))
    }
    // their third-party dependencies, linked from the workspace rather than
    // downloaded — this test is about our own files, not about npm
    for (const [dep, declaredBy] of THIRD_PARTY) {
      const link = join(modules, dep)
      await mkdir(dirname(link), { recursive: true })
      await symlink(realPackageDir(dep, declaredBy), link, 'junction')
    }

    // a package to patch, and a patch to apply
    const target = join(modules, 'tiny-lib')
    await mkdir(target, { recursive: true })
    await writeFile(
      join(target, 'package.json'),
      JSON.stringify({ name: 'tiny-lib', version: '1.0.0', type: 'module', main: './index.mjs' }),
    )
    await writeFile(join(target, 'index.mjs'), 'export class Greeter {\n  greet() {\n    return "plain"\n  }\n}\n')
    await writeFile(
      join(app, 'patch.mjs'),
      'export function patchGreeter({ Greeter }) {\n' +
        '  const orig = Greeter.prototype.greet\n' +
        '  Greeter.prototype.greet = function () {\n' +
        '    return `patched:${orig.call(this)}`\n' +
        '  }\n' +
        '}\n',
    )
    await writeFile(
      join(app, 'wrap.config.mjs'),
      "import { definePatches } from '@wrap-esm-lambda/core'\n\n" +
        'export default definePatches(\n' +
        '  [\n' +
        '    {\n' +
        "      module: { name: 'tiny-lib', versionRange: '>=1 <2', files: ['index.mjs'] },\n" +
        "      patch: { name: 'patchGreeter', from: './patch.mjs' },\n" +
        "      bindings: ['Greeter'],\n" +
        '    },\n' +
        '  ],\n' +
        '  import.meta.url,\n' +
        ')\n',
    )
    await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', type: 'module' }))
    await writeFile(join(app, 'main.mjs'), "import { Greeter } from 'tiny-lib'\n\nconsole.log(new Greeter().greet())\n")

    const env = {
      ...process.env,
      WRAP_ESM_LAMBDA_CONFIG: './wrap.config.mjs',
      // the addon is not part of this test's tarballs; naming the JS engine
      // keeps the run deliberate instead of relying on the fallback warning
      WRAP_ESM_LAMBDA_ENGINE: 'acorn',
    }

    // the runtime shell, from the tarball, through its published `./register`
    const runtime = await execFileAsync(process.execPath, ['--import', '@wrap-esm-lambda/hooks/register', 'main.mjs'], {
      cwd: app,
      env,
    })
    assert.strictEqual(runtime.stdout.trim(), 'patched:plain', 'shipped hooks package instruments the shipped config')

    // and core's `bin`, which nothing else in the suite reaches through a
    // manifest
    const validate = await execFileAsync(
      process.execPath,
      [join(modules, '@wrap-esm-lambda', 'core', 'dist', 'cli.mjs'), './wrap.config.mjs'],
      { cwd: app, env },
    )
    assert.match(validate.stdout, /0 errors, 0 skipped, 1 ok/, 'the validator agrees the config is deliverable')
  } finally {
    await rm(dest, { recursive: true, force: true })
  }
})
