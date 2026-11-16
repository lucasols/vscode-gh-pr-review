import { defineConfig } from 'tsup'

/** Bundle every dependency, except the `vscode` module that the editor provides */
const BUNDLE_ALL = [/^(?!vscode$)/]

export default defineConfig([
  {
    entry: { main: 'src/main.ts' },
    outDir: 'dist',
    format: ['esm'],
    platform: 'node',
    target: 'node20',
    splitting: false,
    external: ['vscode'],
    noExternal: BUNDLE_ALL,
    sourcemap: false,
    minify: true,
    loader: { '.css': 'text' },
  },
  {
    entry: { overview: 'src/webview/overview.ts' },
    outDir: 'dist/webview',
    format: ['iife'],
    platform: 'browser',
    target: 'es2022',
    splitting: false,
    noExternal: [/.*/],
    sourcemap: false,
    minify: true,
    outExtension: () => ({ js: '.js' }),
  },
  {
    entry: { hostTest: 'test-host/hostTest.ts' },
    outDir: 'dist/test-host',
    format: ['cjs'],
    platform: 'node',
    target: 'node20',
    splitting: false,
    external: ['vscode'],
    sourcemap: false,
    outExtension: () => ({ js: '.cjs' }),
  },
])
