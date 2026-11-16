import { execFile } from 'node:child_process'

const MAX_BUFFER = 200 * 1024 * 1024

/** Runs git and returns its output. Rejects when git exits with an error */
export function git(cwd: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      { cwd, encoding: 'buffer', maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.toString('utf8').trim()
          reject(new Error(detail || error.message))
          return
        }
        resolve(stdout)
      },
    )
  })
}

export async function gitText(cwd: string, args: readonly string[]): Promise<string> {
  return (await git(cwd, args)).toString('utf8').trim()
}

export async function gitSucceeds(cwd: string, args: readonly string[]): Promise<boolean> {
  try {
    await git(cwd, args)
    return true
  } catch {
    return false
  }
}
