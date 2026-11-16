import * as assert from 'node:assert/strict'
import * as vscode from 'vscode'

/**
 * Runs inside a real VS Code (see `scripts/run-host-test.mjs`). It checks what
 * the unit tests cannot: that the bundle loads, that the extension activates,
 * and that everything declared in the manifest is wired up.
 *
 * It runs signed out, so it never talks to GitHub.
 */

const EXTENSION_ID = 'lucasols.gh-pr-review'

type Manifest = {
  contributes: {
    commands: { command: string }[]
    menus: Record<string, { command: string }[]>
  }
}

async function waitFor(what: string, check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<{
    services: { store: { status: string; focusedKey: string | undefined } }
    comments: { threadCount: number }
  }>(EXTENSION_ID)
  assert.ok(extension, 'the extension is installed in the test host')

  const api = await extension.activate()
  assert.ok(extension.isActive, 'the extension activates')

  // every command of the manifest is registered, and the other way around
  const manifest: Manifest = extension.packageJSON
  const declared = manifest.contributes.commands.map((item) => item.command).sort()
  const registered = (await vscode.commands.getCommands(true))
    .filter((command) => command.startsWith('ghPrReview.'))
    // VS Code adds these for each view
    .filter((command) => !/\.(focus|open|resetViewLocation|toggleVisibility|removeView)$/.test(command))
    .sort()
  assert.deepEqual(registered, declared, 'registered commands match the manifest')

  for (const [menu, items] of Object.entries(manifest.contributes.menus)) {
    for (const item of items) {
      assert.ok(declared.includes(item.command), `${menu} uses a declared command`)
    }
  }

  // the workspace is a git repository with a GitHub remote, and nobody is signed in
  await waitFor('the repository to be found', () => api.services.store.status !== 'loading')
  await waitFor(
    'the signed out state',
    () => api.services.store.status === 'signedOut',
  )
  assert.equal(api.services.store.focusedKey, undefined)
  assert.equal(api.comments.threadCount, 0)

  // the file system of the pull request documents answers
  const emptyRef = JSON.stringify({ repo: 'acme/app', pr: 1, path: 'src/a.ts', side: 'empty' })
  const emptyUri = vscode.Uri.from({ scheme: 'ghpr', path: '/src/a.ts', query: emptyRef })
  const bytes = await vscode.workspace.fs.readFile(emptyUri)
  assert.equal(bytes.byteLength, 0)
  const document = await vscode.workspace.openTextDocument(emptyUri)
  assert.equal(document.getText(), '')
  assert.equal(document.languageId, 'typescript')

  await assert.rejects(
    async () =>
      vscode.workspace.fs.writeFile(emptyUri, new Uint8Array([1])),
    'the documents are read-only',
  )
  await assert.rejects(
    async () => vscode.workspace.fs.readFile(vscode.Uri.from({ scheme: 'ghpr', path: '/x' })),
    'a document without a reference does not exist',
  )

  // both views can be shown and the commands that need no pull request run
  await vscode.commands.executeCommand('ghPrReview.prs.focus')
  await vscode.commands.executeCommand('ghPrReview.changes.focus').then(
    () => undefined,
    // the view is hidden while signed out
    () => undefined,
  )
  await vscode.commands.executeCommand('ghPrReview.refresh')
  await vscode.commands.executeCommand('ghPrReview.viewAsList')
  assert.equal(
    vscode.workspace.getConfiguration('ghPrReview').get('fileLayout'),
    'list',
  )
  await vscode.commands.executeCommand('ghPrReview.viewAsTree')
  await vscode.commands.executeCommand('ghPrReview.hideViewed')
  assert.equal(
    vscode.workspace.getConfiguration('ghPrReview').get('hideViewedFiles'),
    true,
  )
  await vscode.commands.executeCommand('ghPrReview.showViewed')
  await vscode.commands.executeCommand('ghPrReview.openNextUnviewed')
  await vscode.commands.executeCommand('ghPrReview.openAllChanges')
  await vscode.commands.executeCommand('ghPrReview.markViewed')

  // the stacked editor that the extension uses takes documents of the pull request
  // (VS Code appends the number of files to the title, the extension relies on it)
  await vscode.commands.executeCommand('vscode.changes', 'All Changes in #1', [
    [emptyUri, emptyUri, emptyUri],
  ])
  const tabLabels = () =>
    vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => tab.label))
  await waitFor('the stacked changes tab', () =>
    tabLabels().includes('All Changes in #1 (1 file)'),
  ).catch(
    () => {
      throw new Error(`No stacked changes tab, the tabs are: ${JSON.stringify(tabLabels())}`)
    },
  )
  await vscode.commands.executeCommand('ghPrReview.openDescription')

  // the overview tab opens and its page loads
  await vscode.commands.executeCommand('ghPrReview.openPr', 'acme/app#1')
  assert.equal(api.services.store.focusedKey, 'acme/app#1')
  await waitFor('the overview tab', () =>
    vscode.window.tabGroups.all.some((group) =>
      group.tabs.some((tab) => tab.input instanceof vscode.TabInputWebview),
    ),
  )
}
