/**
 * One machine can be registered as a direct SSH target and paired as a runtime
 * environment at the same time. That gives one on-disk checkout two repo
 * records with independent hidden-worktree state, so the sidebar rendered two
 * identical "N hidden worktrees" rows for a single directory.
 */
import { describe, expect, it } from 'vitest'

import { buildRepoCheckoutKeys, getDuplicateCheckoutNoticeRepoIds } from './host-checkout-identity'
import type { Repo } from '../../../../shared/repo-types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'

function repo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: '/home/brennan/orca',
    displayName: 'orca',
    badgeColor: '#000',
    addedAt: 1,
    ...overrides
  } as Repo
}

function environment(
  id: string,
  endpoint: string,
  overrides: Partial<PublicKnownRuntimeEnvironment> = {}
): PublicKnownRuntimeEnvironment {
  return {
    id,
    name: id,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [{ id: `ws-${id}`, kind: 'websocket', label: 'WebSocket', endpoint }],
    preferredEndpointId: `ws-${id}`,
    ...overrides
  } as PublicKnownRuntimeEnvironment
}

const SSH_REPO = repo('ssh-repo', { connectionId: 'ssh-target-1' })
const ENVIRONMENT_REPO = repo('environment-repo', { executionHostId: 'runtime:env-1' })
const SSH_HOSTS = new Map([['ssh-target-1', 'openclaw.example.ts.net']])
const ENVIRONMENTS = [environment('env-1', 'ws://openclaw.example.ts.net:16770')]

function duplicatesFor(args: {
  repos: readonly Repo[]
  sshTargetHostsById?: ReadonlyMap<string, string>
  runtimeEnvironments?: readonly PublicKnownRuntimeEnvironment[]
  noticeRepoIds?: ReadonlySet<string>
}): Set<string> {
  return getDuplicateCheckoutNoticeRepoIds({
    repos: args.repos,
    noticeRepoIds: args.noticeRepoIds ?? new Set(args.repos.map((entry) => entry.id)),
    checkoutKeyByRepoId: buildRepoCheckoutKeys({
      repos: args.repos,
      sshTargetHostsById: args.sshTargetHostsById ?? SSH_HOSTS,
      runtimeEnvironments: args.runtimeEnvironments ?? ENVIRONMENTS
    })
  })
}

describe('host checkout identity', () => {
  it('keys an SSH target and a paired environment on one machine to one checkout', () => {
    const keys = buildRepoCheckoutKeys({
      repos: [SSH_REPO, ENVIRONMENT_REPO],
      sshTargetHostsById: SSH_HOSTS,
      runtimeEnvironments: ENVIRONMENTS
    })

    expect(keys.get('ssh-repo')).toBe(keys.get('environment-repo'))
  })

  it('shadows the environment twin so one checkout emits one notice row', () => {
    expect([...duplicatesFor({ repos: [SSH_REPO, ENVIRONMENT_REPO] })]).toEqual([
      'environment-repo'
    ])
  })

  it('keeps the client-owned record whichever order the repos arrive in', () => {
    expect([...duplicatesFor({ repos: [ENVIRONMENT_REPO, SSH_REPO] })]).toEqual([
      'environment-repo'
    ])
  })

  it('keeps both rows when the same path lives on two different machines', () => {
    const otherEnvironment = [environment('env-1', 'ws://windows-box.example.ts.net:6768')]

    expect(
      duplicatesFor({
        repos: [SSH_REPO, ENVIRONMENT_REPO],
        runtimeEnvironments: otherEnvironment
      }).size
    ).toBe(0)
  })

  it('keeps both rows when the paired environment answers on loopback', () => {
    // A tunnelled environment reports 127.0.0.1, which would otherwise make
    // every tunnelled host look like the same machine.
    const tunnelled = [environment('env-1', 'ws://127.0.0.1:16770')]

    expect(
      buildRepoCheckoutKeys({
        repos: [ENVIRONMENT_REPO],
        sshTargetHostsById: SSH_HOSTS,
        runtimeEnvironments: tunnelled
      }).size
    ).toBe(0)
    expect(
      duplicatesFor({ repos: [SSH_REPO, ENVIRONMENT_REPO], runtimeEnvironments: tunnelled }).size
    ).toBe(0)
  })

  it('keeps both rows when the SSH target hostname has not hydrated', () => {
    expect(
      duplicatesFor({ repos: [SSH_REPO, ENVIRONMENT_REPO], sshTargetHostsById: new Map() }).size
    ).toBe(0)
  })

  it('keeps two checkouts on one machine apart', () => {
    const secondCheckout = repo('environment-repo', {
      executionHostId: 'runtime:env-1',
      path: '/home/brennan/orca-review'
    })

    expect(duplicatesFor({ repos: [SSH_REPO, secondCheckout] }).size).toBe(0)
  })

  it('never shadows a repo that has no notice row of its own', () => {
    expect(
      duplicatesFor({
        repos: [SSH_REPO, ENVIRONMENT_REPO],
        noticeRepoIds: new Set(['environment-repo'])
      }).size
    ).toBe(0)
  })
})
