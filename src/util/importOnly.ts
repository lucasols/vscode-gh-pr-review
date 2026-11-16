/**
 * Detects changes that only touch the import statements of a TypeScript or
 * JavaScript file. Those changes are usually noise in a review.
 */

const ANALYZABLE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i
const MAX_STATEMENT_LINES = 200

/** A top-level import statement. Excludes `import(...)` and `import.meta` */
const IMPORT_START = /^import(\s|\{|\*|['"])/
const SIDE_EFFECT_IMPORT = /^import\s*['"][^'"]+['"]/
const STATEMENT_END = /(\bfrom\s*['"][^'"]+['"])|(=\s*require\s*\()/

export function canHaveImportOnlyChanges(path: string): boolean {
  return ANALYZABLE.test(path)
}

/** Tells for each line if it is part of an import statement */
export function findImportLines(lines: readonly string[]): boolean[] {
  const result = lines.map(() => false)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined || !IMPORT_START.test(line)) continue

    if (SIDE_EFFECT_IMPORT.test(line)) {
      result[i] = true
      continue
    }

    // the statement ends on the line that names the module
    let end = -1
    const limit = Math.min(lines.length, i + MAX_STATEMENT_LINES)
    for (let j = i; j < limit; j++) {
      const candidate = lines[j]
      if (candidate === undefined) break
      if (j > i && IMPORT_START.test(candidate)) break
      if (STATEMENT_END.test(candidate)) {
        end = j
        break
      }
    }
    if (end === -1) continue

    for (let j = i; j <= end; j++) result[j] = true
    i = end
  }

  return result
}

function split(text: string): { imports: string[]; rest: string[] } {
  const lines = text.split(/\r\n|\n/)
  const isImport = findImportLines(lines)
  const imports: string[] = []
  const rest: string[] = []

  lines.forEach((line, index) => {
    const trimmed = line.trimEnd()
    if (trimmed.trim() === '') return
    if (isImport[index]) imports.push(trimmed)
    else rest.push(trimmed)
  })

  return { imports, rest }
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index])
}

/**
 * Whether two versions of a file only differ in their import statements.
 * Blank lines and trailing whitespace are ignored, any other difference
 * (including comments) makes this false.
 */
export function isImportOnlyChange(before: string, after: string): boolean {
  if (before === after) return false
  const a = split(before)
  const b = split(after)
  return sameLines(a.rest, b.rest) && !sameLines(a.imports, b.imports)
}

const CHANGED_LINE_MAY_BE_IMPORT = [
  /^\s*$/,
  /^import\b/,
  // a name in a multi-line import: `foo,`, `type Foo,`, `foo as bar,`
  /^\s+(type\s+)?[\w$]+(\s+as\s+[\w$]+)?\s*,?\s*$/,
  // the end of a multi-line import: `} from 'module'`
  /^\s*\}?\s*from\s*['"][^'"]+['"]\s*;?\s*$/,
]

/**
 * A cheap check on the patch that rules out most files without reading their
 * content. When it is true the content must still confirm it.
 */
export function patchMayBeImportOnly(patch: string | undefined): boolean {
  if (!patch) return false
  let changedLines = 0

  for (const line of patch.split('\n')) {
    if (line.startsWith('@@') || line.startsWith('\\')) continue
    if (!line.startsWith('+') && !line.startsWith('-')) continue
    changedLines++
    const content = line.slice(1)
    if (!CHANGED_LINE_MAY_BE_IMPORT.some((pattern) => pattern.test(content))) return false
  }

  return changedLines > 0
}
