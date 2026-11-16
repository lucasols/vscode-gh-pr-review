export type Disposable = { dispose: () => void }

/**
 * A minimal event emitter with the same shape as the events of VS Code, so
 * that the model does not depend on the `vscode` module and can be tested.
 */
export class Emitter<T> {
  private readonly listeners = new Set<(value: T) => void>()

  readonly event = (listener: (value: T) => void): Disposable => {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }

  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value)
  }

  dispose(): void {
    this.listeners.clear()
  }
}
