// only types are imported, so that the schema library stays out of the page
import type {
  FromWebviewMessage,
  OverviewEditField,
  OverviewEditOption,
  OverviewState,
  OverviewThread,
  OverviewTimelineItem,
  ToWebviewMessage,
} from '../shared/overviewProtocol'
import { onDiagramThemeChange, renderDiagrams } from './diagrams'

const MESSAGE_TYPES = new Set(['state', 'loading', 'busy', 'done', 'editOptions'])

/**
 * The messages come from the extension, which builds them with the types of
 * the protocol, so checking the kind of message is enough here.
 */
function isToWebviewMessage(data: unknown): data is ToWebviewMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    typeof data.type === 'string' &&
    MESSAGE_TYPES.has(data.type)
  )
}

declare function acquireVsCodeApi(): {
  postMessage: (message: unknown) => void
  setState: (state: unknown) => void
}

const vscode = acquireVsCodeApi()

function send(message: FromWebviewMessage): void {
  vscode.postMessage(message)
}

type Child = Node | string | undefined | false
type Attrs = Record<string, string | boolean | undefined | ((event: Event) => void)>

function h(tag: string, attrs: Attrs = {}, ...children: Child[]): HTMLElement {
  const element = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue
    if (typeof value === 'function') {
      element.addEventListener(name.replace(/^on/, ''), value)
    } else if (value === true) {
      element.setAttribute(name, '')
    } else {
      element.setAttribute(name, value)
    }
  }
  for (const child of children) {
    if (child === undefined || child === false) continue
    element.append(child)
  }
  return element
}

/** GitHub renders and sanitizes this HTML, and the page does not allow scripts */
function markdown(html: string): HTMLElement {
  const element = h('div', { class: 'markdown' })
  element.innerHTML = html
  renderDiagrams(element)
  return element
}

function timeAgo(iso: string): HTMLElement {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return h('span')
  const seconds = Math.max(0, (Date.now() - time) / 1000)
  const units: [number, string][] = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [30, 'day'],
    [12, 'month'],
    [Number.POSITIVE_INFINITY, 'year'],
  ]
  let value = seconds
  let text = 'just now'
  for (const [size, unit] of units) {
    if (value < size) {
      const rounded = Math.floor(value)
      if (unit !== 'second') text = `${rounded} ${unit}${rounded === 1 ? '' : 's'} ago`
      break
    }
    value /= size
  }
  return h('span', { class: 'muted', title: new Date(time).toLocaleString() }, text)
}

function avatar(actor: { login: string; avatarUrl?: string } | undefined): Child {
  if (!actor?.avatarUrl) return undefined
  return h('img', { class: 'avatar', src: actor.avatarUrl, alt: '' })
}

function authorName(actor: { login: string } | undefined): HTMLElement {
  return h('strong', {}, actor?.login ?? 'ghost')
}

const CHECK_ICONS = {
  SUCCESS: { text: '✓', class: 'success', label: 'Passed' },
  FAILURE: { text: '✗', class: 'failure', label: 'Failed' },
  PENDING: { text: '●', class: 'pending', label: 'Running' },
  NONE: { text: '○', class: '', label: 'No status' },
} as const

function checkIcon(state: keyof typeof CHECK_ICONS): HTMLElement {
  const icon = CHECK_ICONS[state]
  return h('span', { class: `icon ${icon.class}`, title: icon.label }, icon.text)
}

const MERGE_LABELS = {
  MERGE: 'Create a merge commit',
  SQUASH: 'Squash and merge',
  REBASE: 'Rebase and merge',
} as const

const elements = {
  status: h('div', { class: 'status' }, 'Loading…'),
  page: h('div', { hidden: true }),
  header: h('div', { class: 'header' }),
  description: h('div'),
  timeline: h('div'),
  threads: h('div'),
  merge: h('div'),
  form: h('div'),
  sidebar: h('div', { class: 'sidebar' }),
}

const commentBox = document.createElement('textarea')
commentBox.placeholder = 'Leave a comment'
const formNote = h('div', { class: 'muted' })
const formActions = h('div', { class: 'form-actions' })

let current: OverviewState | undefined
let currentJson = ''
let busyAction: string | undefined
let selectedMergeMethod: OverviewState['defaultMergeMethod'] | undefined

function actionButton(
  action: string,
  label: string,
  busyLabel: string,
  onClick: () => void,
  options: { primary?: boolean; disabled?: boolean; title?: string } = {},
): HTMLElement {
  return h(
    'button',
    {
      class: options.primary ? 'primary' : undefined,
      disabled: options.disabled === true || busyAction !== undefined,
      title: options.title,
      onclick: onClick,
    },
    busyAction === action ? busyLabel : label,
  )
}

const EDIT_FIELDS = {
  reviewers: {
    action: 'editReviewers',
    title: 'Request reviews',
    placeholder: 'Filter people and teams',
    empty: 'No one found',
    failure: 'Could not load the reviewers',
  },
  labels: {
    action: 'editLabels',
    title: 'Apply labels',
    placeholder: 'Filter labels',
    empty: 'No label found',
    failure: 'Could not load the labels',
  },
} as const

/** The dropdown of a section of the side bar, while it is open */
let editor:
  | {
      field: OverviewEditField
      /** Undefined while the extension loads them */
      options: OverviewEditOption[] | undefined
      error: string | undefined
      checked: Set<string>
      /** The position, in the options that match the filter, that the keyboard is on */
      active: number
    }
  | undefined

// the dropdown is outside of the side bar, which is replaced on every update
const dropdownTitle = h('div', { class: 'dropdown-title' })
const dropdownFilter = document.createElement('input')
dropdownFilter.type = 'text'
dropdownFilter.spellcheck = false
const dropdownList = h('div', { class: 'dropdown-list', role: 'listbox' })
const dropdown = h(
  'div',
  { class: 'dropdown', hidden: true },
  dropdownTitle,
  dropdownFilter,
  dropdownList,
  h(
    'div',
    { class: 'dropdown-footer' },
    h('span', { class: 'muted' }, 'Click outside to apply, Esc to cancel'),
    h('button', { class: 'primary', onclick: () => closeEditor(true) }, 'Apply'),
  ),
)

function editButton(field: OverviewEditField): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-edit="${field}"]`)
}

function matchingOptions(): OverviewEditOption[] {
  const filter = dropdownFilter.value.trim().toLowerCase()
  const options = editor?.options ?? []
  if (!filter) return options
  return options.filter(
    (option) =>
      option.label.toLowerCase().includes(filter) ||
      option.description?.toLowerCase().includes(filter),
  )
}

function optionIcon(field: OverviewEditField, option: OverviewEditOption): HTMLElement {
  if (field === 'labels') {
    const color = /^[0-9a-f]{6}$/i.test(option.color ?? '') ? option.color : undefined
    return h('span', { class: 'dot', style: color ? `background: #${color}` : undefined })
  }
  return option.avatarUrl ?
      h('img', { class: 'avatar', src: option.avatarUrl, alt: '' })
    : h('span', { class: 'avatar placeholder' })
}

function renderDropdownList(): void {
  if (!editor) return
  const { field, checked } = editor
  const texts = EDIT_FIELDS[field]
  const note = (text: string) => h('div', { class: 'dropdown-note' }, text)

  if (editor.error !== undefined) {
    dropdownList.replaceChildren(note(`${texts.failure}: ${editor.error}`))
    return
  }
  if (!editor.options) {
    dropdownList.replaceChildren(note('Loading…'))
    return
  }

  const options = matchingOptions()
  editor.active = Math.max(0, Math.min(editor.active, options.length - 1))
  if (options.length === 0) {
    dropdownList.replaceChildren(note(texts.empty))
    return
  }

  const { active } = editor
  dropdownList.replaceChildren(
    ...options.map((option, index) =>
      h(
        'div',
        {
          class: index === active ? 'option active' : 'option',
          role: 'option',
          'aria-selected': String(checked.has(option.key)),
          title: option.description,
          onclick: () => {
            if (!editor) return
            editor.active = index
            toggleOption(option.key)
          },
        },
        h('span', { class: 'check' }, checked.has(option.key) ? '✓' : ''),
        optionIcon(field, option),
        h(
          'span',
          { class: 'option-text' },
          h('span', { class: 'option-label' }, option.label),
          option.description !== undefined &&
            h('span', { class: 'option-description muted' }, option.description),
        ),
      ),
    ),
  )
  dropdownList.querySelector('.active')?.scrollIntoView({ block: 'nearest' })
}

function toggleOption(key: string): void {
  if (!editor) return
  if (!editor.checked.delete(key)) editor.checked.add(key)
  renderDropdownList()
  dropdownFilter.focus()
}

/** Under the button of its section, aligned to the right side of it */
function positionDropdown(): void {
  if (!editor) return
  const button = editButton(editor.field)
  if (!button) {
    closeEditor(false)
    return
  }
  const rect = button.getBoundingClientRect()
  const left = rect.right + window.scrollX - dropdown.offsetWidth
  dropdown.style.top = `${rect.bottom + window.scrollY + 6}px`
  dropdown.style.left = `${Math.max(8, left)}px`
}

function openEditor(field: OverviewEditField): void {
  editor = { field, options: undefined, error: undefined, checked: new Set(), active: 0 }
  dropdownTitle.textContent = EDIT_FIELDS[field].title
  dropdownFilter.value = ''
  dropdownFilter.placeholder = EDIT_FIELDS[field].placeholder
  dropdown.hidden = false
  renderDropdownList()
  positionDropdown()
  dropdownFilter.focus()
  send({ type: 'loadEditOptions', field })
}

/** Closing saves what is checked, like on GitHub, unless it is cancelled */
function closeEditor(apply: boolean): void {
  if (!editor) return
  const { field, options, checked } = editor
  editor = undefined
  dropdown.hidden = true
  editButton(field)?.focus()
  if (apply && options) send({ type: 'applyEdit', field, checked: [...checked] })
}

dropdownFilter.addEventListener('input', () => {
  if (!editor) return
  editor.active = 0
  renderDropdownList()
})

dropdownFilter.addEventListener('keydown', (event) => {
  if (!editor) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    editor.active += event.key === 'ArrowDown' ? 1 : -1
    renderDropdownList()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const option = matchingOptions()[editor.active]
    if (option) toggleOption(option.key)
  }
})

dropdown.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  event.preventDefault()
  closeEditor(false)
})

document.addEventListener('mousedown', (event) => {
  if (!editor || !(event.target instanceof Element)) return
  // its own button closes it with the click that follows
  if (dropdown.contains(event.target) || event.target.closest('[data-edit]')) return
  closeEditor(true)
})

window.addEventListener('resize', positionDropdown)

function renderHeader(state: OverviewState): void {
  const badge =
    state.state === 'MERGED' ? { class: 'merged', text: 'Merged' }
    : state.state === 'CLOSED' ? { class: 'closed', text: 'Closed' }
    : state.isDraft ? { class: 'draft', text: 'Draft' }
    : { class: 'open', text: 'Open' }

  const verb =
    state.state === 'MERGED' ? 'merged changes into'
    : state.state === 'CLOSED' ? 'wanted to merge changes into'
    : 'wants to merge changes into'
  const who = state.state === 'MERGED' && state.mergedBy ? state.mergedBy : state.author?.login

  elements.header.replaceChildren(
    h(
      'h1',
      { class: 'title' },
      `${state.title} `,
      h('a', { class: 'number', href: state.url }, `#${state.number}`),
    ),
    h(
      'div',
      { class: 'subtitle' },
      h('span', { class: `badge ${badge.class}` }, badge.text),
      avatar(state.author),
      h('strong', {}, who ?? 'ghost'),
      h('span', {}, verb),
      h('code', {}, state.baseRefName),
      h('span', {}, 'from'),
      h('code', {}, state.headRefName),
    ),
    h(
      'div',
      { class: 'actions' },
      state.isCheckedOut ?
        h('button', { disabled: true, title: 'This branch is checked out' }, '✓ Checked out')
      : actionButton('checkout', 'Checkout', 'Checking out…', () => send({ type: 'checkout' }), {
          primary: true,
          disabled: !state.canCheckout,
          title:
            state.canCheckout ? undefined : (
              'The repository of this pull request is not open in this window'
            ),
        }),
      h(
        'button',
        {
          onclick: () => send({ type: 'reviewChanges' }),
          // the Changes view only shows the pull request of the current branch
          disabled: !state.isCheckedOut,
          title:
            state.isCheckedOut ? undefined : (
              'Check out the branch to review the changes in the side bar'
            ),
        },
        `Review changes (${state.viewedCount}/${state.fileCount} viewed)`,
      ),
      actionButton('refresh', 'Refresh', 'Refreshing…', () => send({ type: 'refresh' })),
      h('button', { onclick: () => send({ type: 'openOnGitHub' }) }, 'Open on GitHub'),
      h('button', { onclick: () => send({ type: 'copyLink' }) }, 'Copy link'),
    ),
    h(
      'div',
      { class: 'banner', hidden: !state.refreshError },
      `Could not refresh: ${state.refreshError ?? ''}`,
    ),
  )
}

function renderDescription(state: OverviewState): void {
  elements.description.replaceChildren(
    h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'card-header' },
        avatar(state.author),
        authorName(state.author),
        h('span', { class: 'muted' }, 'opened this pull request'),
        timeAgo(state.createdAt),
      ),
      h(
        'div',
        { class: 'card-body' },
        state.bodyHtml ?
          markdown(state.bodyHtml)
        : h('em', { class: 'muted' }, 'No description provided.'),
      ),
    ),
  )
}

function renderTimelineItem(item: OverviewTimelineItem): Child {
  switch (item.type) {
    case 'comment':
      return h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'card-header' },
          avatar(item.author),
          authorName(item.author),
          h('span', { class: 'muted' }, 'commented'),
          timeAgo(item.createdAt),
          h('span', { class: 'spacer' }),
          h('a', { href: item.url, title: 'Open on GitHub' }, '↗'),
        ),
        h('div', { class: 'card-body' }, markdown(item.bodyHtml)),
      )

    case 'review': {
      const stateText =
        item.state === 'APPROVED' ? { text: 'approved these changes', class: 'approved' }
        : item.state === 'CHANGES_REQUESTED' ? { text: 'requested changes', class: 'changes' }
        : item.state === 'DISMISSED' ? { text: 'left a review that was dismissed', class: '' }
        : item.state === 'PENDING' ? { text: 'started a review (not submitted)', class: '' }
        : { text: 'reviewed', class: '' }
      const header = h(
        'div',
        { class: 'card-header' },
        avatar(item.author),
        authorName(item.author),
        h('span', { class: `review-state ${stateText.class}` }, stateText.text),
        timeAgo(item.createdAt),
        item.commentCount > 0 ?
          h(
            'span',
            { class: 'tag' },
            `${item.commentCount} ${item.commentCount === 1 ? 'comment' : 'comments'}`,
          )
        : undefined,
        h('span', { class: 'spacer' }),
        h('a', { href: item.url, title: 'Open on GitHub' }, '↗'),
      )
      return h(
        'div',
        { class: 'card' },
        header,
        item.bodyHtml ? h('div', { class: 'card-body' }, markdown(item.bodyHtml)) : undefined,
      )
    }

    case 'event': {
      const text =
        item.event === 'merged' ?
          `merged this pull request${item.detail ? ` into ${item.detail}` : ''}`
        : item.event === 'closed' ? 'closed this pull request'
        : item.event === 'reopened' ? 'reopened this pull request'
        : `force-pushed${item.detail ? ` (${item.detail})` : ''}`
      return h(
        'div',
        { class: 'event' },
        h('span', { class: 'muted' }, '◆'),
        avatar(item.author),
        authorName(item.author),
        h('span', {}, text),
        timeAgo(item.createdAt),
      )
    }
  }
}

function renderTimeline(state: OverviewState): void {
  elements.timeline.replaceChildren(...state.timeline.map(renderTimelineItem).filter(isNode))
}

function isNode(child: Child): child is Node {
  return child instanceof Node
}

function renderThread(thread: OverviewThread): HTMLElement {
  const location = h(
    'a',
    {
      class: 'thread-location',
      href: '#',
      title: 'Open the file',
      onclick: (event) => {
        event.preventDefault()
        send({ type: 'openFile', path: thread.path })
      },
    },
    thread.line === undefined ? thread.path : `${thread.path}:${thread.line}`,
  )

  const comments = thread.comments.map((comment) =>
    h(
      'div',
      { class: 'thread-comment' },
      h(
        'div',
        { class: 'meta' },
        avatar(comment.author),
        ' ',
        authorName(comment.author),
        ' ',
        timeAgo(comment.createdAt),
        comment.isPending ? h('span', { class: 'tag' }, 'Pending') : undefined,
      ),
      markdown(comment.bodyHtml),
    ),
  )

  const tags = [
    thread.isResolved ? h('span', { class: 'tag' }, 'Resolved') : undefined,
    thread.isOutdated ? h('span', { class: 'tag' }, 'Outdated') : undefined,
  ]

  if (thread.isResolved) {
    return h(
      'details',
      { class: 'card' },
      h('summary', { class: 'card-header' }, location, ...tags),
      ...comments,
    )
  }
  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-header' }, location, ...tags),
    ...comments,
  )
}

function renderThreads(state: OverviewState): void {
  if (state.threads.length === 0) {
    elements.threads.replaceChildren()
    return
  }
  const unresolved = state.threads.filter((thread) => !thread.isResolved).length
  const sorted = [...state.threads].sort(
    (a, b) => Number(a.isResolved) - Number(b.isResolved),
  )
  elements.threads.replaceChildren(
    h(
      'h2',
      { class: 'section' },
      `Review comments (${unresolved} unresolved of ${state.threads.length})`,
    ),
    ...sorted.map(renderThread),
  )
}

function renderMerge(state: OverviewState): void {
  if (state.state !== 'OPEN') {
    elements.merge.replaceChildren()
    return
  }

  const rows: HTMLElement[] = []
  const row = (icon: HTMLElement, text: string) =>
    rows.push(h('div', { class: 'merge-row' }, icon, h('span', {}, text)))

  if (state.checks.length > 0) {
    const failed = state.checks.filter((check) => check.state === 'FAILURE').length
    const pending = state.checks.filter((check) => check.state === 'PENDING').length
    if (failed > 0) {
      row(checkIcon('FAILURE'), `${failed} of ${state.checks.length} checks failed`)
    } else if (pending > 0) {
      row(checkIcon('PENDING'), `${pending} of ${state.checks.length} checks are running`)
    } else {
      row(checkIcon('SUCCESS'), `All ${state.checks.length} checks passed`)
    }
  }

  if (state.reviewDecision === 'APPROVED') {
    row(checkIcon('SUCCESS'), 'Changes approved')
  } else if (state.reviewDecision === 'CHANGES_REQUESTED') {
    row(checkIcon('FAILURE'), 'Changes requested')
  } else if (state.reviewDecision === 'REVIEW_REQUIRED') {
    row(checkIcon('PENDING'), 'Review required')
  }

  if (state.mergeable === 'CONFLICTING') {
    row(checkIcon('FAILURE'), 'This branch has conflicts that must be resolved')
  } else if (state.mergeable === 'UNKNOWN') {
    row(checkIcon('PENDING'), 'GitHub is checking if this branch can be merged')
  } else if (state.mergeStateStatus === 'BEHIND') {
    row(checkIcon('PENDING'), 'This branch is out of date with the base branch')
  } else if (state.mergeStateStatus === 'BLOCKED') {
    row(checkIcon('PENDING'), 'Merging is blocked by the rules of the base branch')
  } else {
    row(checkIcon('SUCCESS'), 'This branch has no conflicts with the base branch')
  }

  const actions = h('div', { class: 'merge-actions' })

  if (state.isDraft) {
    row(checkIcon('NONE'), 'This pull request is still a draft')
    actions.append(
      actionButton(
        'readyForReview',
        'Ready for review',
        'Updating…',
        () => send({ type: 'readyForReview' }),
        { primary: true, disabled: !state.viewerCanUpdate },
      ),
    )
  }

  const block = state.mergeBlock
  if (block?.kind === 'permission') row(checkIcon('NONE'), block.reason)

  const { autoMerge } = state
  if (autoMerge) {
    const by = autoMerge.enabledBy ? ` by ${autoMerge.enabledBy}` : ''
    const verb = MERGE_LABELS[autoMerge.mergeMethod].toLowerCase()
    row(
      checkIcon('PENDING'),
      `Auto-merge is enabled${by}. GitHub will ${verb} when the requirements are met`,
    )
  }

  const showMerge = !state.isDraft
  const showEnableAutoMerge = !autoMerge && state.canEnableAutoMerge

  if (state.mergeMethods.length === 0) {
    if (showMerge) {
      rows.push(h('div', { class: 'muted' }, 'This repository does not allow merging here.'))
    }
  } else if (showMerge || showEnableAutoMerge) {
    const method =
      selectedMergeMethod && state.mergeMethods.includes(selectedMergeMethod) ?
        selectedMergeMethod
      : state.defaultMergeMethod
    selectedMergeMethod = method

    const select = document.createElement('select')
    for (const option of state.mergeMethods) {
      const element = document.createElement('option')
      element.value = option
      element.textContent = MERGE_LABELS[option]
      element.selected = option === method
      select.append(element)
    }
    select.disabled = busyAction !== undefined
    select.addEventListener('change', () => {
      selectedMergeMethod = state.mergeMethods.find((option) => option === select.value)
    })

    const canMerge = !block || block.canBypass
    actions.append(select)
    if (showMerge) {
      actions.append(
        actionButton(
          'merge',
          block?.canBypass ? 'Bypass rules and merge' : 'Merge pull request',
          'Merging…',
          () => send({ type: 'merge', method: selectedMergeMethod ?? method }),
          {
            primary: !block,
            disabled: !canMerge,
            title: canMerge ? 'You will be asked to confirm' : block.reason,
          },
        ),
      )
    }
    if (showEnableAutoMerge) {
      actions.append(
        actionButton(
          'enableAutoMerge',
          'Enable auto-merge',
          'Enabling…',
          () => send({ type: 'enableAutoMerge', method: selectedMergeMethod ?? method }),
          {
            // the main action while the merge itself has to wait
            primary: showMerge && block !== undefined,
            title:
              'GitHub merges the pull request when its requirements are met. You will be asked to confirm',
          },
        ),
      )
    }
  }

  if (autoMerge && state.canDisableAutoMerge) {
    actions.append(
      actionButton('disableAutoMerge', 'Disable auto-merge', 'Disabling…', () =>
        send({ type: 'disableAutoMerge' }),
      ),
    )
  }

  elements.merge.replaceChildren(
    h('h2', { class: 'section' }, 'Merge'),
    h('div', { class: 'card' }, h('div', { class: 'card-body' }, ...rows, actions)),
  )
}

function renderForm(state: OverviewState): void {
  const pending = state.pendingReviewComments
  formNote.textContent =
    pending === undefined ? '' : (
      `You have a pending review with ${pending} ${pending === 1 ? 'comment' : 'comments'}. Submitting a review publishes ${pending === 1 ? 'it' : 'them'}.`
    )

  const body = () => commentBox.value
  const buttons: HTMLElement[] = []

  if (pending === undefined) {
    buttons.push(
      actionButton(
        'comment',
        'Comment',
        'Commenting…',
        () => {
          if (body().trim()) send({ type: 'comment', body: body() })
          else commentBox.focus()
        },
        { primary: true },
      ),
    )
  } else {
    buttons.push(
      actionButton(
        'review:COMMENT',
        'Submit review',
        'Submitting…',
        () => send({ type: 'review', event: 'COMMENT', body: body() }),
        { primary: true },
      ),
    )
  }

  if (!state.viewerDidAuthor && state.state === 'OPEN') {
    buttons.push(
      actionButton('review:APPROVE', 'Approve', 'Approving…', () =>
        send({ type: 'review', event: 'APPROVE', body: body() }),
      ),
      actionButton('review:REQUEST_CHANGES', 'Request changes', 'Submitting…', () => {
        if (body().trim() || pending !== undefined) {
          send({ type: 'review', event: 'REQUEST_CHANGES', body: body() })
        } else {
          commentBox.focus()
        }
      }),
    )
  }

  formActions.replaceChildren(...buttons)
}

function renderSidebar(state: OverviewState): void {
  const section = (title: string, ...children: Child[]) =>
    h('section', {}, h('h3', {}, title), ...children)
  /** A section whose content is edited in a dropdown under its button */
  const editableSection = (
    title: string,
    edit: { field: OverviewEditField; allowed: boolean; title: string },
    ...children: Child[]
  ) =>
    h(
      'section',
      {},
      h(
        'h3',
        {},
        title,
        edit.allowed &&
          h(
            'button',
            {
              class: 'link',
              'data-edit': edit.field,
              disabled: busyAction !== undefined,
              title: edit.title,
              onclick: () => {
                const isOpen = editor?.field === edit.field
                closeEditor(true)
                if (!isOpen) openEditor(edit.field)
              },
            },
            busyAction === EDIT_FIELDS[edit.field].action ? 'Saving…' : 'Edit',
          ),
      ),
      ...children,
    )
  const none = (text: string) => h('div', { class: 'muted' }, text)

  const reviewerIcon = (reviewerState: OverviewState['reviewers'][number]['state']) => {
    switch (reviewerState) {
      case 'APPROVED':
        return h('span', { class: 'icon success', title: 'Approved' }, '✓')
      case 'CHANGES_REQUESTED':
        return h('span', { class: 'icon failure', title: 'Requested changes' }, '±')
      case 'COMMENTED':
        return h('span', { class: 'icon', title: 'Commented' }, '💬')
      case 'DISMISSED':
        return h('span', { class: 'icon', title: 'Review dismissed' }, '○')
      case 'REQUESTED':
        return h('span', { class: 'icon pending', title: 'Review requested' }, '●')
    }
  }

  const percent =
    state.fileCount === 0 ? 0 : Math.round((state.viewedCount / state.fileCount) * 100)

  elements.sidebar.replaceChildren(
    section(
      'Your review',
      h(
        'div',
        {},
        `${state.viewedCount} of ${state.fileCount} files viewed `,
        h('span', { class: 'muted' }, `+${state.additions} −${state.deletions}`),
      ),
      h('div', { class: 'progress' }, h('div', { style: `width: ${percent}%` })),
    ),
    editableSection(
      'Reviewers',
      {
        field: 'reviewers',
        allowed: state.canEditReviewers,
        title: 'Request or remove reviewers',
      },
      state.reviewers.length === 0 ? none('No reviewers') : undefined,
      ...state.reviewers.map((reviewer) =>
        h(
          'div',
          { class: 'row' },
          avatar({ login: reviewer.name, avatarUrl: reviewer.avatarUrl }),
          h('span', { class: 'name' }, reviewer.name),
          reviewerIcon(reviewer.state),
        ),
      ),
    ),
    section(
      'Assignees',
      state.assignees.length === 0 ? none('No one assigned') : undefined,
      ...state.assignees.map((assignee) =>
        h('div', { class: 'row' }, avatar(assignee), h('span', { class: 'name' }, assignee.login)),
      ),
    ),
    editableSection(
      'Labels',
      { field: 'labels', allowed: state.canEditLabels, title: 'Add or remove labels' },
      state.labels.length === 0 ? none('None yet') : undefined,
      ...state.labels.map((label) =>
        h(
          'span',
          {
            class: 'label',
            style: `border-color: #${label.color}; background: #${label.color}33`,
          },
          label.name,
        ),
      ),
    ),
    section('Milestone', state.milestone ? h('div', {}, state.milestone) : none('No milestone')),
    section(
      'Checks',
      state.checks.length === 0 ? none('No checks') : undefined,
      ...state.checks.map((check) =>
        h(
          'div',
          { class: 'row', title: check.description },
          checkIcon(check.state),
          check.url ?
            h('a', { class: 'name', href: check.url }, check.name)
          : h('span', { class: 'name' }, check.name),
        ),
      ),
    ),
  )
}

function render(): void {
  if (!current) return
  renderHeader(current)
  renderDescription(current)
  renderTimeline(current)
  renderThreads(current)
  renderMerge(current)
  renderForm(current)
  renderSidebar(current)
  positionDropdown()
}

function mount(): void {
  elements.form.append(
    h('h2', { class: 'section' }, 'Add a comment'),
    commentBox,
    formNote,
    formActions,
  )
  elements.page.append(
    elements.header,
    h(
      'div',
      { class: 'layout' },
      h(
        'div',
        {},
        elements.description,
        elements.timeline,
        elements.threads,
        elements.merge,
        elements.form,
      ),
      elements.sidebar,
    ),
  )
  document.body.append(elements.status, elements.page, dropdown)
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!isToWebviewMessage(event.data)) return
  const message = event.data

  switch (message.type) {
    case 'state': {
      const json = JSON.stringify(message.state)
      vscode.setState({ prKey: message.state.prKey })
      elements.status.hidden = true
      elements.page.hidden = false
      if (json === currentJson) return
      currentJson = json
      current = message.state
      render()
      return
    }
    case 'loading':
      vscode.setState({ prKey: message.prKey })
      if (current) return
      elements.status.textContent =
        message.error ? `Could not load the pull request: ${message.error}` : 'Loading…'
      return
    case 'busy':
      busyAction = message.action
      render()
      return
    case 'done':
      if (message.action === 'comment' || message.action.startsWith('review')) {
        commentBox.value = ''
      }
      return
    case 'editOptions':
      if (editor?.field !== message.field || editor.options) return
      editor.error = message.error
      editor.options = message.error === undefined ? (message.options ?? []) : undefined
      editor.checked = new Set(
        (editor.options ?? []).filter((option) => option.checked).map((option) => option.key),
      )
      renderDropdownList()
      return
  }
})

mount()
onDiagramThemeChange(render)
send({ type: 'ready' })
