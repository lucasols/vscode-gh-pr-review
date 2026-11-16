import * as vscode from 'vscode'
import type { CheckState, FileStatus } from '../model/types'

export const TREE_FILE_SCHEME = 'ghpr-tree'
export const TREE_PR_SCHEME = 'ghpr-pr'

/**
 * The decorations are computed from the URI alone. A change of state gives a
 * new URI, so there is nothing to invalidate and nothing that can go stale.
 */
export function toTreeFileUri(
  path: string,
  status: FileStatus,
  changedSinceViewed: boolean,
): vscode.Uri {
  return vscode.Uri.from({
    scheme: TREE_FILE_SCHEME,
    path: `/${path}`,
    query: `${status}${changedSinceViewed ? '&changed' : ''}`,
  })
}

export function toTreePrUri(prKey: string, checkState: CheckState): vscode.Uri {
  return vscode.Uri.from({ scheme: TREE_PR_SCHEME, path: `/${prKey}`, query: checkState })
}

const STATUS_DECORATIONS: Record<FileStatus, { badge: string; color: string; label: string }> =
  {
    added: { badge: 'A', color: 'gitDecoration.addedResourceForeground', label: 'Added' },
    modified: {
      badge: 'M',
      color: 'gitDecoration.modifiedResourceForeground',
      label: 'Modified',
    },
    removed: {
      badge: 'D',
      color: 'gitDecoration.deletedResourceForeground',
      label: 'Deleted',
    },
    renamed: {
      badge: 'R',
      color: 'gitDecoration.renamedResourceForeground',
      label: 'Renamed',
    },
    copied: { badge: 'C', color: 'gitDecoration.addedResourceForeground', label: 'Copied' },
  }

function isFileStatus(value: string): value is FileStatus {
  return value in STATUS_DECORATIONS
}

export class TreeDecorationProvider implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme === TREE_FILE_SCHEME) {
      const [status = '', flag] = uri.query.split('&')
      if (!isFileStatus(status)) return undefined
      const decoration = STATUS_DECORATIONS[status]

      if (flag === 'changed') {
        return {
          badge: decoration.badge,
          color: new vscode.ThemeColor('ghPrReview.changedSinceViewedForeground'),
          tooltip: `${decoration.label}, changed since you viewed it`,
        }
      }
      return {
        badge: decoration.badge,
        color: new vscode.ThemeColor(decoration.color),
        tooltip: decoration.label,
      }
    }

    if (uri.scheme === TREE_PR_SCHEME) {
      switch (uri.query) {
        case 'SUCCESS':
          return {
            badge: '✓',
            color: new vscode.ThemeColor('testing.iconPassed'),
            tooltip: 'Checks passed',
          }
        case 'FAILURE':
          return {
            badge: '✗',
            color: new vscode.ThemeColor('testing.iconFailed'),
            tooltip: 'Checks failed',
          }
        case 'PENDING':
          return {
            badge: '●',
            color: new vscode.ThemeColor('list.warningForeground'),
            tooltip: 'Checks are running',
          }
        default:
          return undefined
      }
    }

    return undefined
  }
}
