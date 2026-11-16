import { describe, expect, test } from 'vitest'
import {
  canHaveImportOnlyChanges,
  findImportLines,
  isImportOnlyChange,
  patchMayBeImportOnly,
} from './importOnly'

function importLineNumbers(source: string): number[] {
  return findImportLines(source.split('\n')).flatMap((isImport, index) =>
    isImport ? [index + 1] : [],
  )
}

describe('findImportLines', () => {
  test('finds single-line, side-effect, namespace and multi-line imports', () => {
    const source = [
      "'use client'", // 1
      "import React from 'react'", // 2
      "import './styles.css'", // 3
      "import * as path from 'node:path'", // 4
      'import type {', // 5
      '  Foo,', // 6
      '  Bar as Baz,', // 7
      "} from './types'", // 8
      '', // 9
      "import fs = require('fs')", // 10
      "import{a}from'./a'", // 11
      'const x = 1', // 12
    ].join('\n')

    expect(importLineNumbers(source)).toEqual([2, 3, 4, 5, 6, 7, 8, 10, 11])
  })

  test('does not treat dynamic imports, import.meta or indented text as imports', () => {
    const source = [
      "import('./lazy').then(run)",
      'import.meta.env.MODE',
      "  import x from 'y'",
      "const a = await import('./a')",
      "export { b } from './b'",
      "// import c from './c'",
    ].join('\n')

    expect(importLineNumbers(source)).toEqual([])
  })

  test('an import that never names a module is not an import', () => {
    expect(importLineNumbers('import {\n  a,\nconst x = 1')).toEqual([])
  })

  test('a broken import does not swallow the next one', () => {
    expect(importLineNumbers("import {\nimport b from './b'")).toEqual([2])
  })
})

describe('isImportOnlyChange', () => {
  const base = [
    "import { a } from './a'",
    "import { b } from './b'",
    '',
    'export function run() {',
    '  return a + b',
    '}',
  ].join('\n')

  test('is true when imports were added, removed, changed or reordered', () => {
    expect(isImportOnlyChange(base, `import { c } from './c'\n${base}`)).toBe(true)
    expect(isImportOnlyChange(base, base.replace("import { b } from './b'\n", ''))).toBe(true)
    expect(isImportOnlyChange(base, base.replace("'./a'", "'../shared/a'"))).toBe(true)
    expect(
      isImportOnlyChange(
        base,
        base.replace(
          "import { a } from './a'\nimport { b } from './b'",
          "import { b } from './b'\nimport { a } from './a'",
        ),
      ),
    ).toBe(true)
  })

  test('is true when a single-line import becomes multi-line, with blank line changes', () => {
    const after = base.replace(
      "import { a } from './a'",
      "import {\n  a,\n  a2,\n} from './a'\n",
    )
    expect(isImportOnlyChange(base, after)).toBe(true)
  })

  test('is false when code changed too', () => {
    const after = `import { c } from './c'\n${base.replace('a + b', 'a + b + c')}`
    expect(isImportOnlyChange(base, after)).toBe(false)
  })

  test('is false when only code or only comments changed', () => {
    expect(isImportOnlyChange(base, base.replace('a + b', 'a - b'))).toBe(false)
    expect(isImportOnlyChange(base, `// note\n${base}`)).toBe(false)
  })

  test('is false when only blank lines changed or nothing changed', () => {
    expect(isImportOnlyChange(base, base.replace("'./b'\n", "'./b'\n\n"))).toBe(false)
    expect(isImportOnlyChange(base, base)).toBe(false)
  })

  test('is false when an export from changed', () => {
    const before = "export { a } from './a'\n"
    expect(isImportOnlyChange(before, "export { a, b } from './a'\n")).toBe(false)
  })
})

describe('patchMayBeImportOnly', () => {
  test('accepts patches whose changed lines can all be part of imports', () => {
    expect(
      patchMayBeImportOnly(
        [
          '@@ -1,4 +1,6 @@',
          " import { a } from './a'",
          "+import { c } from './c'",
          ' import {',
          '+  type Foo,',
          '-  b,',
          '+  b as other,',
          "-} from './b'",
          "+} from './b2'",
          '+',
        ].join('\n'),
      ),
    ).toBe(true)
  })

  test('rejects patches with a changed line of code', () => {
    expect(
      patchMayBeImportOnly(
        ['@@ -1,2 +1,3 @@', "+import { c } from './c'", '-const x = 1', '+const x = c'].join(
          '\n',
        ),
      ),
    ).toBe(false)
  })

  test('rejects missing patches and patches without changes', () => {
    expect(patchMayBeImportOnly(undefined)).toBe(false)
    expect(patchMayBeImportOnly('@@ -1,2 +1,2 @@\n a\n b')).toBe(false)
  })

  test('ignores the marker of a missing newline at the end of the file', () => {
    expect(
      patchMayBeImportOnly(
        "@@ -1 +1 @@\n-import a from './a'\n\\ No newline at end of file\n+import a from './b'",
      ),
    ).toBe(true)
  })
})

test('canHaveImportOnlyChanges', () => {
  expect(canHaveImportOnlyChanges('src/a.ts')).toBe(true)
  expect(canHaveImportOnlyChanges('src/a.test.tsx')).toBe(true)
  expect(canHaveImportOnlyChanges('src/a.mjs')).toBe(true)
  expect(canHaveImportOnlyChanges('src/a.json')).toBe(false)
  expect(canHaveImportOnlyChanges('README.md')).toBe(false)
})
