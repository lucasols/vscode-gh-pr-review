import { afterEach, describe, expect, test, vi } from 'vitest'
import { z } from 'zod'
import { GitHubClient } from './client'

function clientAnswering(body: unknown, status = 200) {
  const fetchMock = vi.fn<typeof fetch>(() =>
    Promise.resolve(
      new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  )
  vi.stubGlobal('fetch', fetchMock)
  const client = new GitHubClient({
    getToken: () => Promise.resolve('token'),
    onUnauthorized: () => undefined,
  })
  return { client, fetchMock }
}

const anySchema = z.record(z.string(), z.unknown())

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GitHubClient', () => {
  // GitHub answers a change that it rejects with an empty result and an error
  const rejected = {
    data: { addLabelsToLabelable: null },
    errors: [{ type: 'FORBIDDEN', message: 'You cannot label this pull request' }],
  }

  test('a mutation that GitHub rejects fails with its message', async () => {
    const { client } = clientAnswering(rejected)
    await expect(client.mutate('mutation', {}, anySchema)).rejects.toMatchObject({
      message: 'You cannot label this pull request',
      kind: 'api',
    })
  })

  test('a query keeps the part of the data that has no error', async () => {
    const { client } = clientAnswering(rejected)
    await expect(client.graphql('query', {}, anySchema)).resolves.toEqual({
      addLabelsToLabelable: null,
    })
  })

  test('a mutation without errors returns its data', async () => {
    const { client } = clientAnswering({ data: { requestReviews: { pullRequest: { id: 'PR' } } } })
    await expect(client.mutate('mutation', {}, anySchema)).resolves.toEqual({
      requestReviews: { pullRequest: { id: 'PR' } },
    })
  })

  test('a REST change sends its body and fails with the message of GitHub', async () => {
    const ok = clientAnswering({}, 200)
    await ok.client.restSend('DELETE', '/repos/acme/app/pulls/1/requested_reviewers', {
      reviewers: ['ana'],
    })
    expect(ok.fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/acme/app/pulls/1/requested_reviewers',
      expect.objectContaining({ method: 'DELETE', body: '{"reviewers":["ana"]}' }),
    )

    const failed = clientAnswering({ message: 'Validation Failed' }, 422)
    await expect(
      failed.client.restSend('DELETE', '/repos/acme/app/pulls/1/requested_reviewers', {}),
    ).rejects.toMatchObject({ message: 'Validation Failed (422)', status: 422 })
  })
})
