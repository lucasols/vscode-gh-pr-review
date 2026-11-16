import { z } from 'zod'

export type GitHubErrorKind = 'auth' | 'notFound' | 'rateLimit' | 'network' | 'api'

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly kind: GitHubErrorKind,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'GitHubError'
  }
}

export type TokenProvider = {
  getToken: () => Promise<string | undefined>
  /** Called when GitHub rejects a token, so that it is not used again */
  onUnauthorized: (token: string) => void
}

const API_URL = 'https://api.github.com'
const REQUEST_TIMEOUT_MS = 30_000

const graphqlEnvelopeSchema = z.object({
  data: z.unknown().optional(),
  errors: z
    .array(z.object({ message: z.string(), type: z.string().optional() }))
    .optional(),
})

const restErrorSchema = z.object({ message: z.string() })

export class GitHubClient {
  constructor(
    private readonly tokens: TokenProvider,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  private async request(
    path: string,
    init: { method: string; accept: string; body?: string },
  ): Promise<Response> {
    const token = await this.tokens.getToken()
    if (!token) throw new GitHubError('Not signed in to GitHub', 'auth')

    let response: Response
    try {
      response = await fetch(`${API_URL}${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: init.accept,
          'content-type': 'application/json',
          'user-agent': 'vscode-gh-pr-review',
          'x-github-api-version': '2022-11-28',
        },
        body: init.body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new GitHubError(`Could not reach GitHub (${reason})`, 'network')
    }

    if (response.status === 401) {
      this.tokens.onUnauthorized(token)
      throw new GitHubError('GitHub rejected the credentials', 'auth', 401)
    }

    if (
      (response.status === 403 || response.status === 429) &&
      response.headers.get('x-ratelimit-remaining') === '0'
    ) {
      throw new GitHubError('GitHub API rate limit exceeded', 'rateLimit', response.status)
    }

    return response
  }

  private async failure(response: Response): Promise<GitHubError> {
    let message = `GitHub request failed (${response.status})`
    try {
      const parsed = restErrorSchema.safeParse(await response.json())
      if (parsed.success) message = `${parsed.data.message} (${response.status})`
    } catch {
      // the body is not JSON, keep the generic message
    }
    return new GitHubError(
      message,
      response.status === 404 ? 'notFound' : 'api',
      response.status,
    )
  }

  async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const response = await this.request('/graphql', {
      method: 'POST',
      accept: 'application/json',
      body: JSON.stringify({ query, variables }),
    })
    if (!response.ok) throw await this.failure(response)

    const json: unknown = await response.json()
    const envelope = graphqlEnvelopeSchema.safeParse(json)
    if (!envelope.success) {
      throw new GitHubError('Unexpected response from GitHub', 'api')
    }

    const { data, errors } = envelope.data
    const errorText = errors?.map((error) => error.message).join('; ')

    if (data === undefined || data === null) {
      const isRateLimit = errors?.some((error) => error.type === 'RATE_LIMITED')
      const isNotFound = errors?.some((error) => error.type === 'NOT_FOUND')
      throw new GitHubError(
        errorText ?? 'Empty response from GitHub',
        isRateLimit ? 'rateLimit'
        : isNotFound ? 'notFound'
        : 'api',
      )
    }

    const parsed = schema.safeParse(data)
    if (!parsed.success) {
      // a partial response usually explains why the data has another shape
      if (errorText) {
        const isNotFound = errors?.some((error) => error.type === 'NOT_FOUND')
        throw new GitHubError(errorText, isNotFound ? 'notFound' : 'api')
      }
      this.log(`Unexpected GraphQL data: ${z.prettifyError(parsed.error)}`)
      throw new GitHubError('Unexpected data from GitHub', 'api')
    }

    if (errorText) this.log(`GraphQL returned partial errors: ${errorText}`)
    return parsed.data
  }

  async restJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const response = await this.request(path, {
      method: 'GET',
      accept: 'application/vnd.github+json',
    })
    if (!response.ok) throw await this.failure(response)

    const json: unknown = await response.json()
    const parsed = schema.safeParse(json)
    if (!parsed.success) {
      this.log(`Unexpected REST data for ${path}: ${z.prettifyError(parsed.error)}`)
      throw new GitHubError('Unexpected data from GitHub', 'api')
    }
    return parsed.data
  }

  /** Downloads raw content. Returns undefined when it does not exist */
  async restBytes(path: string): Promise<Uint8Array | undefined> {
    const response = await this.request(path, {
      method: 'GET',
      accept: 'application/vnd.github.raw+json',
    })
    if (response.status === 404) return undefined
    if (!response.ok) throw await this.failure(response)
    return new Uint8Array(await response.arrayBuffer())
  }
}
