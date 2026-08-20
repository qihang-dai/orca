/**
 * Wiring guard for the relay link of #13892 / #15559.
 *
 * The fix is a sync ECHO probe each PTY host must hand to `PtyStartupIngress`. Deleting
 * that spread left the whole suite green, so it could be refactored away silently.
 * Sibling guards live in `session-same-turn-query-reply-wiring.test.ts`,
 * `local-pty-provider-io-events.test.ts` and `pty-subprocess.test.ts`.
 *
 * Asserted as behaviour, not source text: with the probe wired and the kernel quiet the
 * reply reaches the PTY inside the caller's turn. Without it the reply is queued behind
 * a timer — the deferral that strands it in the next child's stdin.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    pid: process.pid,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))

vi.mock('node-pty', () => ({ spawn: mockPtySpawn }))
vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))

vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mockCreateShellPromptReadinessProbe
}))

import type { PtyHandler } from './pty-handler'
import {
  beginPtyHandlerTest,
  createPtyRequestHelpers,
  endPtyHandlerTest
} from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'

const OSC11_REPLY = '\x1b]11;rgb:1e1e/1e1e/1e1e\x07'
const DA1_REPLY = '\x1b[?1;2c'

describe('relay same-turn query reply wiring', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined
  const { spawnPty } = createPtyRequestHelpers(() => dispatcher)

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
  })

  it('hands the pty’s sync ECHO probe to the startup ingress', async () => {
    const write = vi.fn()
    const readEchoState = vi.fn(() => 0)
    mockPtySpawn.mockReturnValueOnce({ ...mockPtyInstance, write, readEchoState })
    const { id } = await spawnPty()

    dispatcher.callNotification('pty.data', { id, data: OSC11_REPLY })

    // Both matter: the probe must be CONSULTED, and a `quiet` verdict must reach the
    // pty in this turn rather than behind the deferral timer.
    expect(readEchoState).toHaveBeenCalled()
    expect(write).toHaveBeenCalledWith(OSC11_REPLY)
  })

  it('still defers the reply when the pty reports the slave would echo', async () => {
    const write = vi.fn()
    mockPtySpawn.mockReturnValueOnce({ ...mockPtyInstance, write, readEchoState: () => 1 })
    const { id } = await spawnPty()

    dispatcher.callNotification('pty.data', { id, data: OSC11_REPLY })

    expect(write).not.toHaveBeenCalled()
  })

  it('does not let DA1 overtake a held OSC reply', async () => {
    const write = vi.fn()
    mockPtySpawn.mockReturnValueOnce({ ...mockPtyInstance, write, readEchoState: () => 1 })
    const { id } = await spawnPty()

    dispatcher.callNotification('pty.data', { id, data: OSC11_REPLY })
    dispatcher.callNotification('pty.data', { id, data: DA1_REPLY })

    expect(write).not.toHaveBeenCalled()
  })
})
