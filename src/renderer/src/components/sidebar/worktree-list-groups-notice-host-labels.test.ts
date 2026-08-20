/**
 * A project checked out on several hosts emits one discovery-notice row per
 * checkout, and those rows only ever named the project — so a sidebar with a
 * paired remote host showed two identical "N hidden worktrees" buttons with no
 * way to tell which machine either belonged to.
 */
import { describe, expect, it } from 'vitest'
import { buildRows } from './worktree-list/grouping/build-rows'
import {
  repo,
  worktree,
  remoteRepo,
  remoteWorktree,
  project,
  projectHostSetups
} from './worktree-list-groups-test-fixtures'
import type { DetectedWorktree } from '../../../../shared/worktree/types'
import type { Row } from './worktree-list/grouping/row-types'

const HOST_LABELS = new Map([
  ['local', 'Local Mac'],
  ['ssh:gpu-vm', 'openclaw']
])

function detected(path: string): DetectedWorktree {
  return { path, visible: false } as DetectedWorktree
}

function buildNoticeRows(args: {
  inboxRepoIds?: readonly string[]
  importedRepoIds?: readonly string[]
  worktrees?: Parameters<typeof buildRows>[1]
  repoMap?: Parameters<typeof buildRows>[2]
  projectGrouping?: Parameters<typeof buildRows>[17]
}): Row[] {
  const rows = buildRows(
    'repo',
    args.worktrees ?? [worktree, remoteWorktree],
    args.repoMap ??
      new Map([
        [repo.id, repo],
        [remoteRepo.id, remoteRepo]
      ]),
    null,
    new Set(),
    undefined,
    undefined,
    undefined,
    {},
    undefined,
    false,
    undefined,
    [],
    new Set(),
    new Map(
      (args.importedRepoIds ?? []).map((repoId) => [
        repoId,
        {
          repo: repoId === repo.id ? repo : remoteRepo,
          hiddenWorktrees: [detected(`/hidden/${repoId}`)]
        }
      ])
    ),
    new Map(
      (args.inboxRepoIds ?? []).map((repoId) => [
        repoId,
        {
          repo: repoId === repo.id ? repo : remoteRepo,
          inboxWorktrees: [detected(`/inbox/${repoId}`)]
        }
      ])
    ),
    [],
    args.projectGrouping ?? { projects: [project], projectHostSetups },
    [],
    HOST_LABELS
  )
  return rows.filter(
    (row) => row.type === 'new-external-worktrees-inbox' || row.type === 'imported-worktrees-card'
  )
}

describe('discovery notice rows on a multi-host project', () => {
  it('host-qualifies both inbox rows when one project is checked out on two hosts', () => {
    const rows = buildNoticeRows({ inboxRepoIds: [repo.id, remoteRepo.id] })

    expect(
      rows.map((row) => ({
        repoId: row.type === 'new-external-worktrees-inbox' ? row.repo.id : null,
        hostContextLabel: 'hostContextLabel' in row ? row.hostContextLabel : undefined
      }))
    ).toEqual([
      { repoId: repo.id, hostContextLabel: 'Local Mac' },
      { repoId: remoteRepo.id, hostContextLabel: 'openclaw' }
    ])
  })

  it('host-qualifies an imported card that shares the project with a remote inbox row', () => {
    const rows = buildNoticeRows({
      importedRepoIds: [remoteRepo.id],
      inboxRepoIds: [repo.id]
    })

    expect(
      rows.map((row) => ('hostContextLabel' in row ? row.hostContextLabel : undefined))
    ).toEqual(['openclaw', 'Local Mac'])
  })

  it('leaves a single-host project unlabelled', () => {
    const rows = buildNoticeRows({
      inboxRepoIds: [repo.id],
      worktrees: [worktree],
      repoMap: new Map([[repo.id, repo]]),
      projectGrouping: {
        projects: [{ ...project, sourceRepoIds: [repo.id] }],
        projectHostSetups: [projectHostSetups[0]!]
      }
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]).not.toHaveProperty('hostContextLabel')
  })
})
