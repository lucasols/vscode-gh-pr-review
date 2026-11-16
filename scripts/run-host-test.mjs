// Launches a separate VS Code with the extension and runs `test-host/hostTest.ts`
// inside it. The instance has its own profile and no other extensions, and the
// extension is configured to stay signed out, so nothing is sent to GitHub.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runTests } from '@vscode/test-electron'

const root = resolve(import.meta.dirname, '..')
const temp = mkdtempSync(join(tmpdir(), 'gh-pr-review-host-'))
const workspace = join(temp, 'workspace')

mkdirSync(join(workspace, '.vscode'), { recursive: true })
writeFileSync(
  join(workspace, '.vscode', 'settings.json'),
  JSON.stringify({ 'ghPrReview.authSource': 'vscode', 'git.autofetch': false }),
)
writeFileSync(join(workspace, 'README.md'), '# test\n')
const git = (...args) => execFileSync('git', args, { cwd: workspace, stdio: 'ignore' })
git('init', '-b', 'main')
git('remote', 'add', 'origin', 'https://github.com/acme/app.git')

// use the installed VS Code when there is one, to avoid a large download.
// The name of the executable changed between versions.
const macOsDir = '/Applications/Visual Studio Code.app/Contents/MacOS'
const installed = [join(macOsDir, 'Code'), join(macOsDir, 'Electron')].find((path) =>
  existsSync(path),
)

try {
  await runTests({
    vscodeExecutablePath: installed,
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'dist', 'test-host', 'hostTest.cjs'),
    launchArgs: [
      workspace,
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      `--user-data-dir=${join(temp, 'user-data')}`,
      `--extensions-dir=${join(temp, 'extensions')}`,
    ],
  })
  console.info('Host test passed')
} finally {
  rmSync(temp, { recursive: true, force: true, maxRetries: 5 })
}
