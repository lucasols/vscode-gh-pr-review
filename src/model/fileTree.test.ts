import { expect, test } from 'vitest'
import {
  buildFileList,
  buildFileTree,
  flattenFiles,
  type FileTreeNode,
} from './fileTree'

function files(...paths: string[]): { path: string }[] {
  return paths.map((path) => ({ path }))
}

function render(nodes: FileTreeNode<{ path: string }>[], indent = ''): string[] {
  return nodes.flatMap((node) =>
    node.kind === 'file' ?
      [`${indent}${node.name}`]
    : [`${indent}${node.name}/`, ...render(node.children, `${indent}  `)],
  )
}

test('builds a tree with folders before files and joins single folder chains', () => {
  const tree = buildFileTree(
    files(
      'src/agents/builderAgent/builderAgent.utils.ts',
      'src/agents/builderAgent/actions/importRecords.ts',
      'src/agents/builderAgent/actions/builderDeletions.ts',
      '.agents/skills/update-pr/SKILL.md',
      '.agents/skills/create-pr/SKILL.md',
      '.github/workflows/lint.yml',
      'scripts/parallelLint.ts',
      'README.md',
    ),
    { compact: true },
  )

  expect(render(tree)).toMatchInlineSnapshot(`
    [
      ".agents/skills/",
      "  create-pr/",
      "    SKILL.md",
      "  update-pr/",
      "    SKILL.md",
      ".github/workflows/",
      "  lint.yml",
      "scripts/",
      "  parallelLint.ts",
      "src/agents/builderAgent/",
      "  actions/",
      "    builderDeletions.ts",
      "    importRecords.ts",
      "  builderAgent.utils.ts",
      "README.md",
    ]
  `)
})

test('the path of a joined folder is the deepest folder', () => {
  const tree = buildFileTree(files('a/b/c/file.ts'), { compact: true })
  expect(tree).toHaveLength(1)
  const [folder] = tree
  expect(folder?.kind === 'folder' && folder.path).toBe('a/b/c')
  expect(folder?.name).toBe('a/b/c')
})

test('does not join folders when not compact', () => {
  const tree = buildFileTree(files('a/b/file.ts'), { compact: false })
  expect(render(tree)).toEqual(['a/', '  b/', '    file.ts'])
})

test('a folder with a file and a folder is not joined', () => {
  const tree = buildFileTree(files('a/file.ts', 'a/b/other.ts'), { compact: true })
  expect(render(tree)).toEqual(['a/', '  b/', '    other.ts', '  file.ts'])
})

test('sorts names like the explorer, with numbers in order', () => {
  const tree = buildFileTree(files('file10.ts', 'file2.ts', 'File1.ts', 'b.ts', 'A.ts'), {
    compact: true,
  })
  expect(render(tree)).toEqual(['A.ts', 'b.ts', 'File1.ts', 'file2.ts', 'file10.ts'])
})

test('flattenFiles returns the files in display order', () => {
  const tree = buildFileTree(files('z.ts', 'src/b.ts', 'src/a/c.ts', 'a.ts'), {
    compact: true,
  })
  expect(flattenFiles(tree).map((f) => f.path)).toEqual([
    'src/a/c.ts',
    'src/b.ts',
    'a.ts',
    'z.ts',
  ])
})

test('buildFileList sorts by full path', () => {
  expect(buildFileList(files('src/b.ts', 'a.ts', 'src/a.ts')).map((f) => f.path)).toEqual(
    ['a.ts', 'src/a.ts', 'src/b.ts'],
  )
  expect(buildFileList(files('src/b.ts'))[0]?.name).toBe('b.ts')
})
