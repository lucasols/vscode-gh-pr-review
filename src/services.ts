import type * as vscode from 'vscode'
import type { ContentService } from './content/contentService'
import type { Auth } from './github/auth'
import type { ChangeClassifier } from './model/changeClassifier'
import type { LineReviews } from './model/lineReviews'
import type { PrStore } from './model/prStore'

export type Services = {
  context: vscode.ExtensionContext
  store: PrStore
  content: ContentService
  classifier: ChangeClassifier
  lineReviews: LineReviews
  auth: Auth
}
