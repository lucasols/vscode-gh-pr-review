import { existsSync, readFileSync } from 'node:fs'
import { buildSchema, parse, validate } from 'graphql'
import { describe, expect, test } from 'vitest'
import { ALL_DOCUMENTS, buildListsQuery, buildSetViewedMutation } from './queries'

test('every document is valid GraphQL syntax', () => {
  for (const [name, document] of Object.entries(ALL_DOCUMENTS)) {
    expect(() => parse(document), name).not.toThrow()
  }
})

test('the lists query has one search for each category', () => {
  const query = buildListsQuery(3)
  expect(query).toContain('$q0: String!, $q1: String!, $q2: String!')
  expect(query.match(/search\(query:/g)).toHaveLength(3)
})

test('the viewed mutation has one field for each path', () => {
  expect(buildSetViewedMutation(2, true).match(/markFileAsViewed\(/g)).toHaveLength(2)
  expect(buildSetViewedMutation(3, false).match(/unmarkFileAsViewed\(/g)).toHaveLength(3)
})

// `pnpm validate-graphql` downloads the schema of GitHub to this path
const SCHEMA_PATH = '.cache/github-schema.graphql'

describe.skipIf(!existsSync(SCHEMA_PATH))('against the GitHub schema', () => {
  test('every document only uses fields and arguments that exist', () => {
    const schema = buildSchema(readFileSync(SCHEMA_PATH, 'utf8'))
    for (const [name, document] of Object.entries(ALL_DOCUMENTS)) {
      const errors = validate(schema, parse(document)).map((error) => error.message)
      expect(errors, name).toEqual([])
    }
  })
})
