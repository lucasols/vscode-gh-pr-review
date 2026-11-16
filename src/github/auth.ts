import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as vscode from 'vscode'
import { logInfo } from '../log'
import type { TokenProvider } from './client'

const execFileAsync = promisify(execFile)

/**
 * `repo` reads and writes pull requests, `workflow` is needed to merge pull
 * requests that change workflow files and `read:org` shows team reviewers.
 */
const SCOPES = ['repo', 'workflow', 'read:org']
const TOKEN_CACHE_MS = 5 * 60_000
const GH_CANDIDATES = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']

type AuthSource = 'auto' | 'vscode' | 'gh-cli'

function getAuthSource(): AuthSource {
  const value = vscode.workspace
    .getConfiguration('ghPrReview')
    .get<string>('authSource')
  return value === 'vscode' || value === 'gh-cli' ? value : 'auto'
}

async function readGhCliToken(): Promise<string | undefined> {
  for (const command of GH_CANDIDATES) {
    try {
      const { stdout } = await execFileAsync(
        command,
        ['auth', 'token', '--hostname', 'github.com'],
        { timeout: 5000 },
      )
      const token = stdout.trim()
      if (token) return token
    } catch {
      // not installed in this location or not signed in, try the next one
    }
  }
  return undefined
}

/** Finds a GitHub token in the account of VS Code or in the GitHub CLI */
export class Auth implements TokenProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>()
  /** Fires when another token may be available */
  readonly onDidChange = this.emitter.event

  private cached: { token: string; at: number } | undefined
  private readonly rejected = new Set<string>()
  private readonly subscriptions: vscode.Disposable[] = []

  constructor() {
    this.subscriptions.push(
      vscode.authentication.onDidChangeSessions((event) => {
        if (event.provider.id !== 'github') return
        this.cached = undefined
        this.emitter.fire()
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration('ghPrReview.authSource')) return
        this.cached = undefined
        this.emitter.fire()
      }),
    )
  }

  async getToken(): Promise<string | undefined> {
    if (this.cached && Date.now() - this.cached.at < TOKEN_CACHE_MS) {
      return this.cached.token
    }

    const source = getAuthSource()
    let token: string | undefined

    if (source !== 'gh-cli') {
      try {
        const session = await vscode.authentication.getSession('github', SCOPES, {
          silent: true,
        })
        if (session && !this.rejected.has(session.accessToken)) {
          token = session.accessToken
        }
      } catch {
        // no session that this extension can use
      }
    }

    if (!token && source !== 'vscode') {
      const ghToken = await readGhCliToken()
      if (ghToken && !this.rejected.has(ghToken)) {
        token = ghToken
        logInfo('Using the token of the GitHub CLI')
      }
    }

    this.cached = token ? { token, at: Date.now() } : undefined
    return token
  }

  onUnauthorized(token: string): void {
    this.rejected.add(token)
    this.cached = undefined
  }

  /** Asks the user to sign in with the GitHub account of VS Code */
  async signIn(): Promise<boolean> {
    try {
      const session = await vscode.authentication.getSession('github', SCOPES, {
        createIfNone: true,
      })
      this.rejected.delete(session.accessToken)
      this.cached = { token: session.accessToken, at: Date.now() }
      this.emitter.fire()
      return true
    } catch {
      return false
    }
  }

  dispose(): void {
    this.emitter.dispose()
    for (const subscription of this.subscriptions) subscription.dispose()
  }
}
