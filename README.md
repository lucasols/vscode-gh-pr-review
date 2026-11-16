# GH PR Review

Review GitHub pull requests in VS Code. A replacement for the official GitHub
Pull Requests extension that is built around two things:

1. **A list that stays correct.** Pull requests and files refresh in the
   background (on a timer, when the window gets focus, and when the branch or
   commit changes). The tree keeps its expansion and selection, and when
   GitHub cannot be reached the last data stays visible.
2. **Changes since viewed.** When a file that you marked as viewed changes,
   a click on it opens only what changed since you viewed it.

## Features

- **Pull Requests view**: the open pull requests of the repository, grouped by
  the searches of `ghPrReview.queries` (waiting for my review, created by me,
  all open).
- **Changes view**: the files of one pull request as a tree or a list, with a
  checkbox to mark each file or folder as viewed. Viewed files can be hidden
  with the eye button.
- **Diffs**: against the merge base, like on GitHub. When the pull request is
  checked out, the right side is the file of the workspace, so it can be
  edited and has full language support.
- **All changes stacked**: the button in the title of the Changes view opens
  the diffs of all files in one editor, in the order of the view. The same
  button on a folder opens only the files of that folder. With viewed files
  hidden, only the files left to review are included.
- **Overview tab**: description, checks, reviewers, conversation, and the
  buttons to merge, check out, comment, approve or request changes.
- **Comments**: review threads are shown in the diffs and in the files of the
  workspace. Add single comments, start a review, reply, edit, delete and
  resolve.
- **Status bar**: the pull request of the checked-out branch.

### Changes since viewed

GitHub knows that a viewed file changed, but not which version you viewed. The
extension remembers that version for each file. Then:

- the file is shown in another color with the description `changed since viewed`
- a click opens the diff between the version that you viewed and the current one
- the history button in the editor title switches to the full diff and back
- `Open Changes Since Commit…` in the context menu compares with any commit of
  the pull request, for files that do not have a viewed version

The viewed versions are stored on this machine. A file that was marked as
viewed on github.com gets its version the next time the extension sees it as
viewed, so keep VS Code open on the pull request, or mark files as viewed here.

### Changes that are not relevant

Some changes are noise in a review. They get an indicator in the tree:

| Indicator      | Meaning                                                    |
| -------------- | ---------------------------------------------------------- |
| `lockfile`     | A lockfile of a package manager, e.g. `pnpm-lock.yaml`      |
| `rename only`  | The file was renamed or moved, its content is the same      |
| `imports only` | Only import statements changed (TypeScript and JavaScript) |

They can be marked as viewed automatically:

```jsonc
"ghPrReview.autoMarkNonRelevantChangesAsViewed": ["lockfile", "renameOnly", "importsOnly"]
```

For a file that changed since it was viewed, only the changes made since then
count. Each version of a file is marked at most once, so a file that you
unmark stays unmarked.

## Settings

| Setting                                         | Default      | Description                                      |
| ----------------------------------------------- | ------------ | ------------------------------------------------ |
| `ghPrReview.queries`                            | 3 categories | The categories of the Pull Requests view         |
| `ghPrReview.refreshIntervalSeconds`             | `60`         | How often GitHub is asked for changes            |
| `ghPrReview.fileLayout`                         | `tree`       | Show the files as a `tree` or a `list`           |
| `ghPrReview.hideViewedFiles`                    | `false`      | Hide the viewed files from the Changes view      |
| `ghPrReview.autoMarkNonRelevantChangesAsViewed` | `[]`         | Kinds of changes that are marked automatically   |
| `ghPrReview.defaultDiff`                        | `sinceViewed`| What a click on a file that changed since viewed opens |
| `ghPrReview.useLocalFiles`                      | `true`       | Use the files of the workspace in the diffs      |
| `ghPrReview.authSource`                         | `auto`       | `vscode` account, `gh-cli`, or `auto` for both   |

## Authentication

The GitHub account of VS Code is used. Without one, the token of the GitHub
CLI (`gh auth token`) is used. Only github.com is supported.

## Using it together with the official extension

Disable the GitHub Pull Requests extension in the workspaces where you use
this one. Both show the review comments, so every thread would appear twice.

## Development

```sh
pnpm install
pnpm dev                # rebuild on change, then press F5
pnpm test               # unit tests
pnpm test:host          # activates the extension in a separate, signed-out VS Code
pnpm validate-graphql   # checks every GraphQL document against the schema of GitHub
pnpm build-and-install  # lint, test, package and install
```

The tests that read from the real GitHub API are skipped unless a token is set:

```sh
GH_PR_REVIEW_LIVE_TOKEN=$(gh auth token) pnpm vitest run src/github/api.live.test.ts
```
