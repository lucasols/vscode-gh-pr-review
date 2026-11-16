/**
 * Runs a task so that it never overlaps with itself. A request made while the
 * task is running queues exactly one more run, which starts after the current
 * one ends, so the caller always gets a result that is newer than its request.
 */
export class SerialTask {
  private running: Promise<void> | undefined
  private queued: Promise<void> | undefined

  constructor(private readonly task: () => Promise<void>) {}

  run(): Promise<void> {
    if (!this.running) {
      const current = this.task().finally(() => {
        this.running = undefined
      })
      this.running = current
      return current
    }

    if (!this.queued) {
      this.queued = this.running
        .catch(() => undefined)
        .then(() => {
          this.queued = undefined
          return this.run()
        })
    }
    return this.queued
  }

  get isRunning(): boolean {
    return this.running !== undefined
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function debounce(
  fn: () => void,
  ms: number,
): { call: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    call() {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        fn()
      }, ms)
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size))
  }
  return result
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
