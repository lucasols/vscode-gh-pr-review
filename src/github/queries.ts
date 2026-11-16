/**
 * The GraphQL documents sent to GitHub. `pnpm validate-graphql` checks all of
 * them against the public schema of GitHub.
 */

const ACTOR = `login avatarUrl(size: 64)`

const PR_SUMMARY_FRAGMENT = /* GraphQL */ `
  fragment PrSummary on PullRequest {
    id
    number
    title
    url
    isDraft
    state
    updatedAt
    author { ${ACTOR} }
    baseRefName
    headRefName
    headRefOid
    isCrossRepository
    headRepositoryOwner { login }
    reviewDecision
    repository { nameWithOwner }
    lastCommit: commits(last: 1) {
      nodes { commit { statusCheckRollup { state } } }
    }
  }
`

const THREAD_FRAGMENT = /* GraphQL */ `
  fragment Thread on PullRequestReviewThread {
    id
    path
    line
    startLine
    diffSide
    subjectType
    isResolved
    isOutdated
    viewerCanResolve
    viewerCanUnresolve
    viewerCanReply
    comments(first: 100) {
      nodes {
        id
        body
        bodyHTML
        createdAt
        url
        state
        author { ${ACTOR} }
        viewerCanUpdate
        viewerCanDelete
      }
    }
  }
`

/** Builds the query that loads all the categories of the list in one request */
export function buildListsQuery(count: number): string {
  const variables = Array.from({ length: count }, (_, i) => `$q${i}: String!`).join(', ')
  const searches = Array.from(
    { length: count },
    (_, i) => /* GraphQL */ `
      q${i}: search(query: $q${i}, type: ISSUE, first: 50) {
        issueCount
        nodes { ... on PullRequest { ...PrSummary } }
      }
    `,
  ).join('\n')

  return /* GraphQL */ `
    query PrLists(${variables}) {
      viewer { login }
      ${searches}
    }
    ${PR_SUMMARY_FRAGMENT}
  `
}

export const VIEWER_QUERY = /* GraphQL */ `
  query Viewer {
    viewer { login }
  }
`

export const BRANCH_PRS_QUERY = /* GraphQL */ `
  query BranchPrs($owner: String!, $name: String!, $branch: String!) {
    repository(owner: $owner, name: $name) {
      pullRequests(
        headRefName: $branch
        first: 10
        orderBy: { field: UPDATED_AT, direction: DESC }
      ) {
        nodes { ...PrSummary }
      }
    }
  }
  ${PR_SUMMARY_FRAGMENT}
`

export const PR_DETAIL_QUERY = /* GraphQL */ `
  query PrDetail($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      mergeCommitAllowed
      squashMergeAllowed
      rebaseMergeAllowed
      viewerDefaultMergeMethod
      pullRequest(number: $number) {
        ...PrSummary
        bodyHTML
        baseRefOid
        createdAt
        additions
        deletions
        mergeable
        mergeStateStatus
        viewerCanUpdate
        viewerDidAuthor
        mergedBy { login }
        labels(first: 30) { nodes { name color } }
        assignees(first: 20) { nodes { ${ACTOR} } }
        milestone { title }
        reviewRequests(first: 30) {
          nodes {
            requestedReviewer {
              __typename
              ... on User { ${ACTOR} }
              ... on Bot { ${ACTOR} }
              ... on Mannequin { ${ACTOR} }
              ... on Team { name teamAvatarUrl: avatarUrl(size: 64) }
            }
          }
        }
        latestOpinionatedReviews(first: 30) {
          nodes { state author { ${ACTOR} } }
        }
        pendingReviews: reviews(states: [PENDING], first: 5) {
          nodes { id viewerDidAuthor comments { totalCount } }
        }
        checks: commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun { name conclusion status detailsUrl }
                    ... on StatusContext { context state targetUrl description }
                  }
                }
              }
            }
          }
        }
        reviewThreads(first: 100) {
          pageInfo { hasNextPage endCursor }
          nodes { ...Thread }
        }
        files(first: 100) {
          pageInfo { hasNextPage endCursor }
          nodes { path additions deletions changeType viewerViewedState }
        }
        timelineItems(
          last: 100
          itemTypes: [
            ISSUE_COMMENT
            PULL_REQUEST_REVIEW
            HEAD_REF_FORCE_PUSHED_EVENT
            MERGED_EVENT
            CLOSED_EVENT
            REOPENED_EVENT
          ]
        ) {
          nodes {
            __typename
            ... on IssueComment {
              id
              bodyHTML
              createdAt
              url
              author { ${ACTOR} }
            }
            ... on PullRequestReview {
              id
              state
              bodyHTML
              createdAt
              submittedAt
              url
              author { ${ACTOR} }
              comments { totalCount }
            }
            ... on HeadRefForcePushedEvent {
              id
              createdAt
              actor { ${ACTOR} }
              beforeCommit { abbreviatedOid }
              afterCommit { abbreviatedOid }
            }
            ... on MergedEvent {
              id
              createdAt
              actor { ${ACTOR} }
              mergeRefName
            }
            ... on ClosedEvent {
              id
              createdAt
              actor { ${ACTOR} }
            }
            ... on ReopenedEvent {
              id
              createdAt
              actor { ${ACTOR} }
            }
          }
        }
      }
    }
  }
  ${PR_SUMMARY_FRAGMENT}
  ${THREAD_FRAGMENT}
`

export const PR_FILES_PAGE_QUERY = /* GraphQL */ `
  query PrFilesPage($owner: String!, $name: String!, $number: Int!, $after: String!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        headRefOid
        files(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { path additions deletions changeType viewerViewedState }
        }
      }
    }
  }
`

export const PR_THREADS_PAGE_QUERY = /* GraphQL */ `
  query PrThreadsPage($owner: String!, $name: String!, $number: Int!, $after: String!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { ...Thread }
        }
      }
    }
  }
  ${THREAD_FRAGMENT}
`

export const PR_HEAD_QUERY = /* GraphQL */ `
  query PrHead($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) { headRefOid }
    }
  }
`

export const PR_COMMITS_QUERY = /* GraphQL */ `
  query PrCommits($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        commits(last: 100) {
          nodes { commit { oid abbreviatedOid messageHeadline committedDate } }
        }
      }
    }
  }
`

/** Builds the mutation that marks or unmarks several files as viewed at once */
export function buildSetViewedMutation(count: number, viewed: boolean): string {
  const field = viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed'
  const variables = Array.from({ length: count }, (_, i) => `$p${i}: String!`).join(', ')
  const mutations = Array.from(
    { length: count },
    (_, i) => /* GraphQL */ `
      m${i}: ${field}(input: { pullRequestId: $pr, path: $p${i} }) {
        pullRequest { headRefOid }
      }
    `,
  ).join('\n')

  return /* GraphQL */ `
    mutation SetViewed($pr: ID!, ${variables}) {
      ${mutations}
    }
  `
}

const COMMENT_RESULT = `id state pullRequestReview { id state }`

export const ADD_THREAD_MUTATION = /* GraphQL */ `
  mutation AddThread($input: AddPullRequestReviewThreadInput!) {
    addPullRequestReviewThread(input: $input) {
      thread {
        id
        comments(first: 1) { nodes { ${COMMENT_RESULT} } }
      }
    }
  }
`

export const ADD_THREAD_REPLY_MUTATION = /* GraphQL */ `
  mutation AddThreadReply($input: AddPullRequestReviewThreadReplyInput!) {
    addPullRequestReviewThreadReply(input: $input) {
      comment { ${COMMENT_RESULT} }
    }
  }
`

export const ADD_REVIEW_MUTATION = /* GraphQL */ `
  mutation AddReview($input: AddPullRequestReviewInput!) {
    addPullRequestReview(input: $input) {
      pullRequestReview { id state }
    }
  }
`

export const SUBMIT_REVIEW_MUTATION = /* GraphQL */ `
  mutation SubmitReview($input: SubmitPullRequestReviewInput!) {
    submitPullRequestReview(input: $input) {
      pullRequestReview { id state }
    }
  }
`

export const DELETE_REVIEW_MUTATION = /* GraphQL */ `
  mutation DeleteReview($input: DeletePullRequestReviewInput!) {
    deletePullRequestReview(input: $input) {
      pullRequestReview { id }
    }
  }
`

export const UPDATE_COMMENT_MUTATION = /* GraphQL */ `
  mutation UpdateComment($input: UpdatePullRequestReviewCommentInput!) {
    updatePullRequestReviewComment(input: $input) {
      pullRequestReviewComment { id }
    }
  }
`

export const DELETE_COMMENT_MUTATION = /* GraphQL */ `
  mutation DeleteComment($input: DeletePullRequestReviewCommentInput!) {
    deletePullRequestReviewComment(input: $input) {
      pullRequestReview { id }
    }
  }
`

export const RESOLVE_THREAD_MUTATION = /* GraphQL */ `
  mutation ResolveThread($input: ResolveReviewThreadInput!) {
    resolveReviewThread(input: $input) {
      thread { id isResolved }
    }
  }
`

export const UNRESOLVE_THREAD_MUTATION = /* GraphQL */ `
  mutation UnresolveThread($input: UnresolveReviewThreadInput!) {
    unresolveReviewThread(input: $input) {
      thread { id isResolved }
    }
  }
`

export const ADD_ISSUE_COMMENT_MUTATION = /* GraphQL */ `
  mutation AddIssueComment($input: AddCommentInput!) {
    addComment(input: $input) {
      clientMutationId
    }
  }
`

export const MERGE_MUTATION = /* GraphQL */ `
  mutation Merge($input: MergePullRequestInput!) {
    mergePullRequest(input: $input) {
      pullRequest { id state }
    }
  }
`

export const READY_FOR_REVIEW_MUTATION = /* GraphQL */ `
  mutation ReadyForReview($input: MarkPullRequestReadyForReviewInput!) {
    markPullRequestReadyForReview(input: $input) {
      pullRequest { id isDraft }
    }
  }
`

/** Every document, so that they can be validated against the schema */
export const ALL_DOCUMENTS: Record<string, string> = {
  lists: buildListsQuery(2),
  viewer: VIEWER_QUERY,
  branchPrs: BRANCH_PRS_QUERY,
  prDetail: PR_DETAIL_QUERY,
  prFilesPage: PR_FILES_PAGE_QUERY,
  prThreadsPage: PR_THREADS_PAGE_QUERY,
  prHead: PR_HEAD_QUERY,
  prCommits: PR_COMMITS_QUERY,
  markViewed: buildSetViewedMutation(2, true),
  unmarkViewed: buildSetViewedMutation(2, false),
  addThread: ADD_THREAD_MUTATION,
  addThreadReply: ADD_THREAD_REPLY_MUTATION,
  addReview: ADD_REVIEW_MUTATION,
  submitReview: SUBMIT_REVIEW_MUTATION,
  deleteReview: DELETE_REVIEW_MUTATION,
  updateComment: UPDATE_COMMENT_MUTATION,
  deleteComment: DELETE_COMMENT_MUTATION,
  resolveThread: RESOLVE_THREAD_MUTATION,
  unresolveThread: UNRESOLVE_THREAD_MUTATION,
  addIssueComment: ADD_ISSUE_COMMENT_MUTATION,
  merge: MERGE_MUTATION,
  readyForReview: READY_FOR_REVIEW_MUTATION,
}
