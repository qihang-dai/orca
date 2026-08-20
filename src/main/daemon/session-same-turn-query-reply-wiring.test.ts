/**
 * Wiring guard for #13892's only real-world delivery path.
 *
 * The fix is a sync ECHO probe that each PTY host must hand to `PtyStartupIngress`.
 * Deleting that spread here — or in local-pty-provider or the relay's pty-handler —
 * left the whole suite green, so the fix could be refactored away silently. Sibling
 * guards live in `local-pty-provider-io-events.test.ts`, `pty-handler-output-drain-differential.test.ts` and
 * `pty-subprocess.test.ts` (which builds the probe this host is handed).
 *
 * Asserted as behavior, not source text: with the probe wired and the kernel quiet the
 * reply reaches the subprocess INSIDE the caller's turn. Without it the reply is queued
 * behind a timer, which is exactly the deferral that strands it in the next child's stdin.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Session } from './session'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { PtySlaveEchoSyncProbe } from '../../shared/pty-slave-line-discipline-echo'

vi.mock('../pty-descendant-termination', () => ({ killWithDescendantSweep: vi.fn() }))

const OSC11_REPLY = '\x1b]11;rgb:1e1e/1e1e/1e1e\x07'

function createSubprocess(echoSyncProbe?: PtySlaveEchoSyncProbe): {
  handle: SubprocessHandle
  written: string[]
} {
  const written: string[] = []
  return {
    written,
    handle: {
      pid: 4242,
      getForegroundProcess: () => null,
      ...(echoSyncProbe ? { echoSyncProbe } : {}),
      write: (data: string) => void written.push(data),
      resize: () => {},
      kill: () => {},
      forceKill: () => {},
      signal: () => {},
      onData: () => {},
      onExit: () => {},
      dispose: () => {}
    }
  }
}

describe('Session hands its subprocess ECHO probe to the startup ingress (#13892)', () => {
  let session: Session | null = null

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    session?.dispose()
    session = null
    vi.useRealTimers()
  })

  function start(echoSyncProbe?: PtySlaveEchoSyncProbe): { written: string[] } {
    const subprocess = createSubprocess(echoSyncProbe)
    session = new Session({
      sessionId: 'echo-sync-probe-wiring',
      cols: 80,
      rows: 24,
      subprocess: subprocess.handle,
      shellReadySupported: false,
      ownerBackend: 'posix-pty'
    })
    return subprocess
  }

  it('writes a live color reply in the caller’s own turn when the probe says quiet', () => {
    const echoSyncProbe = vi.fn<PtySlaveEchoSyncProbe>(() => 'quiet')
    const { written } = start(echoSyncProbe)

    session?.write(OSC11_REPLY)

    // Both matter: the probe must be CONSULTED (the spread exists) and its verdict must
    // reach the wire now (the reply is not queued). Deleting the spread fails both.
    expect(echoSyncProbe).toHaveBeenCalled()
    expect(written).toEqual([OSC11_REPLY])
  })

  it('still defers when the probe says the slave would echo', () => {
    const { written } = start(() => 'echoing')

    session?.write(OSC11_REPLY)

    expect(written).toEqual([])
  })

  it('defers when the host has no probe, so an unpatched node-pty keeps today’s behavior', () => {
    const { written } = start()

    session?.write(OSC11_REPLY)

    expect(written).toEqual([])
  })

  it('does not let DA1 overtake a held OSC reply on an unpatched host', () => {
    const da1 = '\x1b[?1;2c'
    const { written } = start()

    session?.write(OSC11_REPLY)
    session?.write(da1)

    expect(written).toEqual([])
    vi.runOnlyPendingTimers()
    expect(written).toEqual([OSC11_REPLY, da1])
  })

  it('holds a coalesced DA1+CPR payload behind a deferred OSC reply', () => {
    const coalesced = '\x1b[?1;2c\x1b[1;1R'
    const { written } = start()

    session?.write(OSC11_REPLY)
    session?.write(coalesced)

    expect(written).toEqual([])
    vi.runOnlyPendingTimers()
    expect(written).toEqual([OSC11_REPLY, '\x1b[?1;2c', '\x1b[1;1R'])
  })
  // A query reply must not jump the post-ready flush gate: the startup command is parked
  // there, and a CPR written ahead of it is read by the shell's line editor as an unbound
  // key plus literal text, so the shell runs `4;1Recho ...` and the agent never launches.
  it('keeps a CPR reply behind the buffered startup command', async () => {
    const { handle, written } = createSubprocess(() => 'quiet')
    const session = new Session({
      id: 'sess-gate',
      subprocess: handle,
      shellReadySupported: true
    } as never)

    session.write('claude\n')
    session.write('\x1b[24;1R')

    // Still parked: neither byte has reached the PTY while the gate holds.
    expect(written.join('')).not.toContain('24;1R')
    session.dispose?.()
  })
})
