import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import {
  getActiveNativeChatWatcherCount,
  subscribeNativeChatTranscript,
  type NativeChatTranscriptSubscription,
  type SubscribeNativeChatTranscriptArgs
} from './transcript-watch'

let tempRoots: string[] = []
let subscriptions: NativeChatTranscriptSubscription[] = []

beforeEach(() => {
  tempRoots = []
  subscriptions = []
})

afterEach(async () => {
  // Tear down before the temp dirs go away: a failed assertion must not leak a
  // poll loop into the next test's watcher-count assertions.
  for (const subscription of subscriptions) {
    subscription.unsubscribe()
  }
  subscriptions = []
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function pendingFilePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-unresolved-'))
  tempRoots.push(root)
  return join(root, 'rollout.jsonl')
}

type Snapshot = { messages: NativeChatMessage[]; error?: string }

async function subscribe(
  args: Omit<SubscribeNativeChatTranscriptArgs, 'agent' | 'sessionId' | 'onAppend'>,
  snapshots: Snapshot[]
): Promise<NativeChatTranscriptSubscription> {
  const subscription = await subscribeNativeChatTranscript({
    agent: 'claude',
    sessionId: 'ignored',
    onAppend: () => {},
    onInitialSnapshot: (messages, _hasMore, _beforeOffset, error) =>
      snapshots.push({ messages, error }),
    ...args
  })
  subscriptions.push(subscription)
  return subscription
}

/** Why: a plain write creates the file empty first, and a fast poll tick can
 *  install on the zero-byte file — the initial snapshot would then be empty and
 *  the turn would arrive as an append instead. Rename publishes it complete. */
async function publishTranscript(filePath: string, content: string): Promise<void> {
  const staging = `${filePath}.staging`
  await writeFile(staging, content)
  await rename(staging, filePath)
}

function claudeLine(uuid: string, role: 'user' | 'assistant', text: string): string {
  return `${JSON.stringify({
    type: role,
    uuid,
    timestamp: new Date().toISOString(),
    message: { role, content: [{ type: 'text', text }] }
  })}\n`
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('waitFor timed out')
}

// #13663: an agent in an SSH worktree writes its transcript on the remote host,
// so this host resolves nothing and the poll spins forever with no frame — the
// client sits on a spinner indefinitely. The poll is still correct for a
// not-yet-flushed local session (#8401), so the notice must be advisory.
describe('subscribeNativeChatTranscript unresolved-transcript notice (#13663)', () => {
  it('reports the transcript as unavailable once the deadline passes', async () => {
    const snapshots: Snapshot[] = []

    await subscribe(
      { filePath: await pendingFilePath(), resolvePollIntervalMs: 10, unresolvedNoticeMs: 30 },
      snapshots
    )

    await waitFor(() => snapshots.length > 0)
    expect(snapshots[0]?.messages).toEqual([])
    expect(snapshots[0]?.error).toMatch(/no transcript found for this session on this machine/i)
  })

  // The #8401 false-positive guard: before the deadline an unresolved transcript
  // is just slow, and one that arrives in that window must load clean.
  it('stays silent before the deadline and loads a late transcript without an advisory', async () => {
    const snapshots: Snapshot[] = []
    const filePath = await pendingFilePath()

    await subscribe(
      { filePath, debounceMs: 5, resolvePollIntervalMs: 10, unresolvedNoticeMs: 10_000 },
      snapshots
    )

    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(snapshots).toHaveLength(0)

    await publishTranscript(filePath, claudeLine('u-1', 'user', 'slow first flush'))
    await waitFor(() => snapshots.length > 0)
    expect(snapshots[0]?.error).toBeUndefined()
    expect(snapshots[0]?.messages.map((m) => m.id)).toEqual(['u-1'])
  })

  // The notice must not be a terminal state: the poll keeps running, so a
  // transcript that shows up late still loads.
  it('keeps polling after the notice and still loads the transcript once it appears', async () => {
    const snapshots: Snapshot[] = []
    const filePath = await pendingFilePath()

    const sub = await subscribe(
      { filePath, debounceMs: 5, resolvePollIntervalMs: 10, unresolvedNoticeMs: 30 },
      snapshots
    )

    await waitFor(() => snapshots.some((s) => s.error))

    // Sit past the deadline for ~10 further poll ticks: the advisory is latched,
    // so it must not repeat on every miss.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(snapshots).toHaveLength(1)

    await publishTranscript(filePath, claudeLine('u-1', 'user', 'late but real'))
    await waitFor(() => snapshots.some((s) => s.messages.some((m) => m.id === 'u-1')))

    expect(snapshots.at(-1)?.error).toBeUndefined()
    expect(getActiveNativeChatWatcherCount()).toBe(1)
    expect(snapshots.filter((s) => s.error)).toHaveLength(1)

    sub.unsubscribe()
    expect(getActiveNativeChatWatcherCount()).toBe(0)
  })
})
