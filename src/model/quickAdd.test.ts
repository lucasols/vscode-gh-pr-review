import { expect, test } from 'vitest'
import { labelsToOffer, reviewersToOffer } from './quickAdd'
import type { LabelOption, Reviewer, ReviewerOption } from './types'

function user(slug: string): ReviewerOption {
  return { kind: 'user', id: `U_${slug}`, slug, name: undefined, avatarUrl: undefined }
}

function team(slug: string): ReviewerOption {
  return { kind: 'team', id: `T_${slug}`, slug, name: slug, avatarUrl: undefined }
}

function reviewer(
  kind: Reviewer['kind'],
  slug: string,
  state: Reviewer['state'] = 'REQUESTED',
): Reviewer {
  return { kind, slug, name: slug, avatarUrl: undefined, state }
}

function label(name: string): LabelOption {
  return { id: `L_${name}`, name, color: 'ffffff', description: undefined }
}

test('offers who the setting lists, in the order of the options', () => {
  const offered = reviewersToOffer({
    offered: new Set(['core', 'bruno', 'ana', 'gone']),
    options: [user('Ana'), user('bruno'), user('carla'), team('core')],
    reviewers: [],
    author: undefined,
  })

  expect(offered.map((option) => option.id)).toEqual(['U_Ana', 'U_bruno', 'T_core'])
})

test('does not offer the author nor who already is a reviewer', () => {
  const offered = reviewersToOffer({
    offered: new Set(['ana', 'bruno', 'carla', 'core']),
    options: [user('ana'), user('bruno'), user('carla'), user('core'), team('core')],
    reviewers: [reviewer('user', 'Bruno'), reviewer('team', 'core', 'APPROVED')],
    author: 'Ana',
  })

  // the user `core` is not the team `core`
  expect(offered.map((option) => option.id)).toEqual(['U_carla', 'U_core'])
})

test('offers the labels of the setting that the repository has, in its order', () => {
  const offered = labelsToOffer({
    names: ['beta feature', 'Unknown', 'bug', 'Bug'],
    options: [label('bug'), label('Beta Feature'), label('docs')],
    labels: [],
  })

  expect(offered.map((option) => option.name)).toEqual(['Beta Feature', 'bug'])
})

test('does not offer a label that the pull request has', () => {
  const offered = labelsToOffer({
    names: ['bug', 'docs'],
    options: [label('bug'), label('docs')],
    labels: [{ id: 'L_bug' }],
  })

  expect(offered.map((option) => option.name)).toEqual(['docs'])
})
