// Downloads the public GraphQL schema of GitHub (when it is not cached) and
// runs the test that validates every document of the extension against it.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'

const SCHEMA_URL = 'https://docs.github.com/public/fpt/schema.docs.graphql'
const SCHEMA_PATH = '.cache/github-schema.graphql'
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

const isFresh =
  existsSync(SCHEMA_PATH) && Date.now() - statSync(SCHEMA_PATH).mtimeMs < MAX_AGE_MS

if (!isFresh) {
  console.info(`Downloading ${SCHEMA_URL}`)
  const response = await fetch(SCHEMA_URL)
  if (!response.ok) {
    throw new Error(`Failed to download the schema: ${response.status}`)
  }
  mkdirSync('.cache', { recursive: true })
  writeFileSync(SCHEMA_PATH, await response.text())
}

execFileSync('pnpm', ['vitest', 'run', 'src/github/queries.test.ts'], {
  stdio: 'inherit',
})
