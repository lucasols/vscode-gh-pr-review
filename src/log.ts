import * as vscode from 'vscode'

let channel: vscode.LogOutputChannel | undefined

export function initLog(): vscode.LogOutputChannel {
  channel = vscode.window.createOutputChannel('GH PR Review', { log: true })
  return channel
}

export function logInfo(message: string): void {
  channel?.info(message)
}

export function logWarn(message: string): void {
  channel?.warn(message)
}

export function logError(message: string): void {
  channel?.error(message)
}
