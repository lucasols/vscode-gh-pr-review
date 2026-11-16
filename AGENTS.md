# GH PR Review

VS Code extension to review GitHub pull requests. See `README.md` for what it does.

## Commands

- `pnpm lint`: type-check and lint. Run it after every change.
- `pnpm test`: unit tests (vitest).
- `pnpm test:host`: activates the bundle in a separate, signed-out VS Code and
  checks that the manifest and the code agree. Run it after changing
  `package.json`, `src/main.ts` or `src/commands.ts`.
- `pnpm validate-graphql`: validates `src/github/queries.ts` against the public
  schema of GitHub. Run it after changing a query.
- `pnpm build-and-install`: package and install the extension.

## Architecture

```
src/
  main.ts            activation: wires everything, polling, context keys
  commands.ts        all commands, except the ones of the comments
  model/             no `vscode` imports, fully unit-tested
    prStore.ts       the single source of truth (lists, details, mutations)
    baselines.ts     which version of each file the user viewed
    changeClassifier.ts  lockfile / rename only / imports only
  github/            GraphQL + REST client, zod schemas of every response
  content/           file contents by git blob, cached; `ghpr:` file system
  git/               local repositories, checkout
  views/             trees, comments, overview panel, status bar
  webview/           the page of the overview tab (plain DOM, no framework)
  shared/            the messages between the extension and the webview
```

## Rules

- `model/`, `github/`, `content/contentService.ts` and `util/` must not import
  `vscode`, so that they can be tested with vitest.
- The views never fetch. They render what `PrStore` has and call its methods.
  `getChildren` and `getTreeItem` must stay synchronous and free of network.
- Tree items need a stable `id`, otherwise the tree loses its state on refresh.
- The store fires a change event only when the data really changed.
- Responses of GitHub are parsed with zod (`github/schemas.ts`), never cast.
- Every setting, command and menu is declared in `package.json`. The host test
  fails when a command is declared but not registered, or the other way around.
- The webview imports only types from `shared/`, to keep zod out of its bundle.

## Viewed baselines

GitHub reports `viewerViewedState` but not the version that was viewed. The
extension stores a baseline (blob and commit) per file when it marks a file as
viewed, and also whenever it observes a file as `VIEWED` (a viewed file is
unchanged since it was viewed). After a new head commit is first seen, existing
baselines are not overwritten for `BASELINE_SETTLE_MS`, because GitHub can
report the old state for a moment. Read the tests of `baselines.ts` and
`prStore.ts` before changing this.
