import { diffArrays } from 'diff'

export type LineMapper = {
  /** Whether both texts are the same, so every line maps to itself */
  identical: boolean
  /** Maps a 1-based line of the source to the target, or undefined if it changed */
  toTarget: (line: number) => number | undefined
  /** Maps a 1-based line of the target to the source, or undefined if it changed */
  toSource: (line: number) => number | undefined
}

function splitLines(text: string): string[] {
  return text.split(/\r\n|\n/)
}

const IDENTITY: LineMapper = {
  identical: true,
  toTarget: (line) => line,
  toSource: (line) => line,
}

/**
 * Maps the lines that did not change between two versions of a file. It is
 * used to place the comments of the pull request version in a local file that
 * has changes which were not pushed.
 */
export function createLineMapper(source: string, target: string): LineMapper {
  if (source === target) return IDENTITY

  const forward = new Map<number, number>()
  const backward = new Map<number, number>()

  let sourceLine = 1
  let targetLine = 1
  for (const part of diffArrays(splitLines(source), splitLines(target))) {
    const count = part.value.length
    if (part.added) {
      targetLine += count
    } else if (part.removed) {
      sourceLine += count
    } else {
      for (let i = 0; i < count; i++) {
        forward.set(sourceLine + i, targetLine + i)
        backward.set(targetLine + i, sourceLine + i)
      }
      sourceLine += count
      targetLine += count
    }
  }

  return {
    identical: false,
    toTarget: (line) => forward.get(line),
    toSource: (line) => backward.get(line),
  }
}
