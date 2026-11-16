export type FileTreeFolder<T> = {
  kind: 'folder'
  /** Full path of the folder, without a trailing slash */
  path: string
  /** Displayed name. Chains of single folders are joined, e.g. `src/utils` */
  name: string
  children: FileTreeNode<T>[]
}

export type FileTreeLeaf<T> = {
  kind: 'file'
  path: string
  name: string
  file: T
}

export type FileTreeNode<T> = FileTreeFolder<T> | FileTreeLeaf<T>

type MutableFolder<T> = {
  path: string
  name: string
  folders: Map<string, MutableFolder<T>>
  files: FileTreeLeaf<T>[]
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function compareNames(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0)
}

function toNodes<T>(folder: MutableFolder<T>, compact: boolean): FileTreeNode<T>[] {
  const folders = [...folder.folders.values()]
    .sort((a, b) => compareNames(a.name, b.name))
    .map((child): FileTreeFolder<T> => {
      let current = child
      let name = child.name
      if (compact) {
        // join chains of folders that only contain one folder
        for (;;) {
          const [onlyFolder] = current.folders.values()
          if (current.files.length > 0 || current.folders.size !== 1 || !onlyFolder) break
          name = `${name}/${onlyFolder.name}`
          current = onlyFolder
        }
      }
      return {
        kind: 'folder',
        path: current.path,
        name,
        children: toNodes(current, compact),
      }
    })

  const files = [...folder.files].sort((a, b) => compareNames(a.name, b.name))
  return [...folders, ...files]
}

/** Builds the folder tree of a list of files, with folders before files */
export function buildFileTree<T extends { path: string }>(
  files: readonly T[],
  options: { compact: boolean },
): FileTreeNode<T>[] {
  const root: MutableFolder<T> = { path: '', name: '', folders: new Map(), files: [] }

  for (const file of files) {
    const segments = file.path.split('/')
    const fileName = segments.pop()
    if (fileName === undefined) continue

    let folder = root
    for (const segment of segments) {
      let next = folder.folders.get(segment)
      if (!next) {
        next = {
          path: folder.path ? `${folder.path}/${segment}` : segment,
          name: segment,
          folders: new Map(),
          files: [],
        }
        folder.folders.set(segment, next)
      }
      folder = next
    }
    folder.files.push({ kind: 'file', path: file.path, name: fileName, file })
  }

  return toNodes(root, options.compact)
}

/** Lists the files as a flat list sorted by path */
export function buildFileList<T extends { path: string }>(
  files: readonly T[],
): FileTreeLeaf<T>[] {
  return files
    .map((file): FileTreeLeaf<T> => {
      const index = file.path.lastIndexOf('/')
      return { kind: 'file', path: file.path, name: file.path.slice(index + 1), file }
    })
    .sort((a, b) => compareNames(a.path, b.path))
}

export function collectFiles<T>(node: FileTreeNode<T>): T[] {
  if (node.kind === 'file') return [node.file]
  return node.children.flatMap((child) => collectFiles(child))
}

/** The files in the order that they are displayed */
export function flattenFiles<T>(nodes: readonly FileTreeNode<T>[]): T[] {
  return nodes.flatMap((node) => collectFiles(node))
}
