/** Files that package managers generate. They are not reviewed line by line */
const LOCKFILE_NAMES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'deno.lock',
  'cargo.lock',
  'gemfile.lock',
  'poetry.lock',
  'uv.lock',
  'pdm.lock',
  'pipfile.lock',
  'composer.lock',
  'go.sum',
  'flake.lock',
  'podfile.lock',
  'pubspec.lock',
  'mix.lock',
  'packages.lock.json',
  'gradle.lockfile',
])

export function isLockfile(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  return LOCKFILE_NAMES.has(name)
}
