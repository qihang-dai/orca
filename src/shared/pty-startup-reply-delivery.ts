import type { PtyOwnerBackend } from './pty-owner-backend'
export type { PtyStartupReplyEchoMatch } from './pty-startup-reply-echo-shapes'
import {
  isBetterEchoMatch,
  locateEcho,
  replyEchoProjections,
  type PtyStartupReplyEchoMatch
} from './pty-startup-reply-echo-shapes'
import type { PtySlaveEchoProbe, PtySlaveEchoSyncProbe } from './pty-slave-line-discipline-echo'

// Why bytes and not reads: the echo is a fixed ~30 bytes, but nothing bounds how the
// tty chunks them — an SSH relay or a slow drain delivers a few bytes at a time, and a
// per-read budget is then spent inside the echo itself. What actually bounds a live
// projection is the startup deadline; this is only a backstop against a pathological
// pre-deadline stream, so it is set well above any splash an echo could arrive behind.
const ECHO_SEARCH_BUDGET_BYTES = 256 * 1024
// Why far tighter past the deadline: a reply still on the wire at expiry deserves the
// read or two its echo takes, but nothing beyond it — see reset().
const ECHO_POST_DEADLINE_BUDGET_BYTES = 512
// Why this tight: the querying program is blocked on the reply, so every interval is
// latency it pays. A raw-mode switch lands within a turn or two of the query, and the
// probe is a subprocess — this is the smallest interval that does not spin on it.
const ECHO_POLL_INTERVAL_MS = 20
// Why a budget at all: the startup deadline runs to 30s, which at this interval is a
// four-figure count of probe subprocesses. It is also the wrong bound — a tty still
// cooked this long after its own query never leaves cooked mode, and waiting on it only
// delays a reply that will echo whenever it is sent.
//
// Why wall-clock rather than a probe count: each probe is a subprocess, so a multi-pane
// restore serializes them on fork — a count-based cap measured ~26ms per probe across
// 30 panes, turning a nominal 200ms into ~8s of withholding and blowing past every
// query timeout at once. A deadline spends fewer probes under load instead of taking
// longer, which is the direction that fails safe: measured flat at ~210ms of withholding
// from 1 to 100 concurrent panes, with probe spawns plateauing rather than scaling.
//
// In-flight probes are deadline-raced below, so reply latency stays inside this budget.
const ECHO_POLL_BUDGET_MS = 200
// Live replies make both queues session-lived, so cap them under query floods.
const MAX_TRACKED_REPLIES = 64
const ECHO_PROBE_MAX_STARTS_PER_SECOND = 10

type ExpectedEcho = { projections: readonly string[]; remainingBytes: number }
type PendingWrite = {
  reply: string
  onFailed: (() => void) | undefined
  /** Arm echo projections when this entry is written. */
  projectEcho: boolean
  /** Rode the queue only to keep order; the caller was already told it was sent. */
  ordered: boolean
}
type ActiveEchoProbe = { timer: ReturnType<typeof setTimeout> | null }

function defersWrite(ownerBackend: PtyOwnerBackend): boolean {
  return ownerBackend === 'posix-pty'
}

// Why this module exists: a startup color reply is written to the PTY master, so
// whatever line discipline sits between Orca and the querying program can echo it
// straight back out as ordinary output (#12112). ConPTY echoes it with the ESC
// bytes stripped; a POSIX tty echoes it while the querying program is still cooked.
// A program that queries before clearing ECHO loses that race if Orca answers
// inside the query's own turn, so on POSIX the write waits until the slave's ECHO
// bit is observably clear, and recognized echo shapes cover what remains. When a
// fork-free probe can prove ECHO is already clear, the wait is skipped outright —
// see `answer()`, and #13892 for why deferring a reply that needs no wait is unsafe.
//
// Deliberately NO re-send on a matched echo: ECHO copies bytes to the master
// without consuming them from the slave's input queue, so a program that arms raw
// mode with TCSANOW/TCSADRAIN (libuv's setRawMode, hence Node-based agents) still
// receives the reply, and re-writing would duplicate it in stdin. A TCSAFLUSH
// switcher does discard it; that case is left to the query timeout, because a
// duplicate reply corrupts a parser that is already mid-read.
//
// Why not PostReadyFlushGate's settle-and-fallback shape, which solves this same
// "don't write while ECHO is on" race for shell startup input: that gate defers
// bytes nothing is waiting on, so it can wait for the stream to go observably
// quiet. A color reply is different — the querying program is blocked on it and
// times out — so the wait here is bounded by a budget and always ends in a write.
//
// There are TWO echo sources and they are independent, which is the thing to hold onto
// when reading the rest of this file:
//
//   1. The kernel line discipline, when ECHO is set. Readable state — the probe asks
//      the slave directly, and waiting for it to clear removes this echo outright.
//   2. The foreground line editor, in software. readline echoes a master write as if
//      it were typed *while the tty is raw with ECHO off*, so the probe's verdict says
//      nothing about it. Verified on a live pty: at a bash prompt the probe reports
//      `quiet` and readline still emits `BEL 10;rgb:2e2e/3434/3434`.
//
// So `quiet` is proof about (1) only. It gates the withholding and retires the caret
// projection, and must never be read as "no suppression needed" — that reintroduces
// #12112 at a shell prompt, which is the foreground for most of an agent pane's
// startup window. The projections below stay armed for (2) on every path.

/** Owns when a startup color reply is written and how its own echo is recognized. */
export class PtyStartupReplyDelivery {
  private readonly expectedEchoes: ExpectedEcho[] = []
  private readonly pendingWrites: PendingWrite[] = []
  private writeTimer: ReturnType<typeof setTimeout> | null = null
  private activeEchoProbe: ActiveEchoProbe | null = null
  private echoPollDeadline = 0
  private echoProbeWindowStartedAt: number | null = null
  private echoProbeStartsInWindow = 0
  private closed = false

  constructor(
    private readonly ownerBackend: PtyOwnerBackend,
    private readonly writeProvider: (data: string) => void,
    private readonly echoProbe?: PtySlaveEchoProbe,
    private readonly echoSyncProbe?: PtySlaveEchoSyncProbe
  ) {}

  /** True while a reply is queued but unwritten, so later writes must not overtake it. */
  get hasDeferredWrites(): boolean {
    return this.pendingWrites.length > 0
  }

  get hasExpectedEcho(): boolean {
    return this.expectedEchoes.length > 0
  }

  /**
   * True once the reply has been written or accepted for a later write.
   *
   * `onFailed` fires only for the second case: a deferred write reports success
   * before it happens, so the caller's bookkeeping for THIS reply is a lie if the
   * write later throws. Scoped per reply because the replies to one query are
   * written independently — one failing says nothing about the ones that landed.
   */
  answer(reply: string, onFailed?: () => void): boolean {
    if (this.closed) {
      return false
    }
    if (!defersWrite(this.ownerBackend)) {
      // Why: ConPTY answers the query itself unless Orca beats it in this turn.
      return this.writeReply(reply)
    }
    // Why answer in this turn when the kernel is already quiet: ANY deferral, however
    // short, lets a reply written later in the same turn overtake this one — a DA1 read
    // sentinel does exactly that, and the held OSC reply then lands in the NEXT child's
    // stdin (#13892). Measured: the leak reproduces at a 5ms defer, so only a same-turn
    // write closes it. Requiring an empty queue is what preserves order: a reply
    // arriving behind a held one still queues instead of jumping it.
    if (this.pendingWrites.length === 0 && this.echoSyncProbe?.() === 'quiet') {
      return this.writeReply(reply, onFailed, true)
    }
    if (this.pendingWrites.length >= MAX_TRACKED_REPLIES) {
      this.flushPendingWrites()
    }
    // A fresh queue starts a fresh budget, so a second query arriving after the first
    // one exhausted its own still gets probed rather than going straight to guessing.
    if (this.pendingWrites.length === 0) {
      this.echoPollDeadline = Date.now() + ECHO_POLL_BUDGET_MS
    }
    this.pendingWrites.push({ reply, onFailed, projectEcho: true, ordered: false })
    this.armWriteTimer()
    return true
  }

  /**
   * Writes a reply that needs no echo containment, keeping it behind any that do.
   *
   * A colour probe writes `OSC 11 ;? ST` then `CSI 6n` and stops reading at the CPR,
   * treating it as proof the terminal answered: a CPR that jumps a still-deferred
   * colour reply strands that reply in the tty for whatever runs next to read
   * (`gh auth login` -> "unexpected escape sequence from terminal", #15559).
   *
   * Deliberately does NOT arm the write timer — the echo-risk entry that made the queue
   * non-empty already owns the continuation, and re-arming would fork a second probe.
   */
  answerInOrder(reply: string): boolean {
    if (this.closed) {
      return false
    }
    // Captured BEFORE the overflow flush: a reply that had to wait is written into a
    // window where ECHO may still be set, so it needs projections even once the flush
    // has emptied the queue out from under it.
    const followsEchoRiskReply = this.pendingWrites.length > 0
    if (this.pendingWrites.length >= MAX_TRACKED_REPLIES) {
      // Flushing keeps order without growing the queue; this reply is written after it.
      this.flushPendingWrites()
    }
    if (this.pendingWrites.length === 0) {
      return this.writeReply(reply, undefined, false, followsEchoRiskReply)
    }
    // Why projected, unlike an unqueued write: a reply forced behind an echo-risk write
    // can flush while ECHO is still set, and would then be echoed onto a cooked prompt.
    this.pendingWrites.push({ reply, onFailed: undefined, projectEcho: true, ordered: true })
    return true
  }

  /** Recognizes any written reply's echo anywhere in the span, earliest match first. */
  matchEcho(data: string): PtyStartupReplyEchoMatch {
    let best: PtyStartupReplyEchoMatch = { kind: 'none' }
    let bestIndex = -1
    for (const [index, expected] of this.expectedEchoes.entries()) {
      const match = locateEcho(expected.projections, data)
      if (isBetterEchoMatch(match, best)) {
        best = match
        bestIndex = index
      }
    }
    if (best.kind === 'complete') {
      this.expectedEchoes.splice(bestIndex, 1)
      return best
    }
    return best
  }

  /**
   * Bytes that went by without completing an echo. Charged by the caller once per PTY
   * read rather than per `matchEcho` call, which runs several times over one span.
   */
  chargeEchoSearch(byteCount: number): void {
    for (let index = this.expectedEchoes.length - 1; index >= 0; index -= 1) {
      const expected = this.expectedEchoes[index]
      if (!expected) {
        continue
      }
      expected.remainingBytes -= byteCount
      if (expected.remainingBytes <= 0) {
        this.expectedEchoes.splice(index, 1)
      }
    }
  }

  /**
   * Startup window closed. Replies already on the wire stay recognizable, but only
   * across the next few hundred bytes: an unbounded projection would keep deleting
   * matching spans out of ordinary output for the rest of the session.
   */
  reset(): void {
    this.flushPendingWrites()
    for (const expected of this.expectedEchoes) {
      expected.remainingBytes = Math.min(expected.remainingBytes, ECHO_POST_DEADLINE_BUDGET_BYTES)
    }
  }

  /**
   * Teardown. An echo-risk reply has nowhere left to go — its reader is gone. An
   * ordered one is an ordinary write this queue only borrowed for sequencing, and the
   * caller was already told it was sent, so it is handed to the pty best-effort: the
   * child can still be alive here (daemon dispose drains before the kill).
   */
  close(): void {
    this.closed = true
    this.clearWriteTimer()
    this.clearActiveEchoProbe()
    for (const pending of this.pendingWrites.splice(0)) {
      if (pending.ordered) {
        try {
          this.writeProvider(pending.reply)
        } catch {
          /* pty already torn down */
        }
      }
    }
    this.expectedEchoes.length = 0
  }

  private armWriteTimer(delayMs = 0): void {
    // A probe in flight is already the continuation: re-arming forks a second stty and
    // makes the first one's verdict unusable (the identity bail below discards it).
    if (this.writeTimer || this.activeEchoProbe) {
      return
    }
    this.writeTimer = setTimeout(() => this.attemptPendingWrites(), delayMs)
    this.writeTimer.unref?.()
  }

  /**
   * Why poll rather than write on the first turn: one deferred turn cannot prove the
   * querying program left cooked mode, and the leak happens precisely because Orca
   * answered before it got there. Waiting costs the program nothing it is not already
   * spending — it is blocked on this reply either way.
   */
  private attemptPendingWrites(): void {
    this.clearWriteTimer()
    if (this.closed || this.pendingWrites.length === 0) {
      return
    }
    if (!this.echoProbe || Date.now() >= this.echoPollDeadline || !this.claimEchoProbeStart()) {
      this.flushPendingWrites()
      return
    }
    const active: ActiveEchoProbe = { timer: null }
    active.timer = setTimeout(
      () => {
        if (this.activeEchoProbe !== active) {
          return
        }
        this.activeEchoProbe = null
        this.flushPendingWrites()
      },
      Math.max(0, this.echoPollDeadline - Date.now())
    )
    active.timer.unref?.()
    this.activeEchoProbe = active
    void this.echoProbe()
      .catch(() => 'unknown' as const)
      .then((state) => {
        if (this.activeEchoProbe !== active) {
          return
        }
        this.clearActiveEchoProbe()
        if (this.closed || this.pendingWrites.length === 0) {
          return
        }
        if (state === 'echoing') {
          this.armWriteTimer(ECHO_POLL_INTERVAL_MS)
          return
        }
        // `quiet` retires the kernel caret projection; `unknown` keeps both shapes.
        this.flushPendingWrites(state === 'quiet')
      })
  }

  private flushPendingWrites(kernelEchoImpossible = false): void {
    this.clearWriteTimer()
    this.clearActiveEchoProbe()
    for (const pending of this.pendingWrites.splice(0)) {
      this.writeReply(pending.reply, pending.onFailed, kernelEchoImpossible, pending.projectEcho)
    }
  }

  private clearWriteTimer(): void {
    if (!this.writeTimer) {
      return
    }
    clearTimeout(this.writeTimer)
    this.writeTimer = null
  }

  private clearActiveEchoProbe(): void {
    if (!this.activeEchoProbe) {
      return
    }
    if (this.activeEchoProbe.timer) {
      clearTimeout(this.activeEchoProbe.timer)
    }
    this.activeEchoProbe = null
  }

  private claimEchoProbeStart(): boolean {
    const now = Date.now()
    if (
      this.echoProbeWindowStartedAt === null ||
      now < this.echoProbeWindowStartedAt ||
      now - this.echoProbeWindowStartedAt >= 1_000
    ) {
      this.echoProbeWindowStartedAt = now
      this.echoProbeStartsInWindow = 0
    }
    if (this.echoProbeStartsInWindow >= ECHO_PROBE_MAX_STARTS_PER_SECOND) {
      return false
    }
    this.echoProbeStartsInWindow += 1
    return true
  }

  private writeReply(
    reply: string,
    onFailed?: () => void,
    kernelEchoImpossible = false,
    projectEcho = true
  ): boolean {
    if (this.closed) {
      return false
    }
    const projections = projectEcho
      ? replyEchoProjections(reply, this.ownerBackend, kernelEchoImpossible)
      : []
    // Why: register before write because node-pty can synchronously re-enter onData.
    const expected: ExpectedEcho | null =
      projections.length > 0 ? { projections, remainingBytes: ECHO_SEARCH_BUDGET_BYTES } : null
    if (expected) {
      this.expectedEchoes.push(expected)
    }
    try {
      this.writeProvider(reply)
      if (this.expectedEchoes.length > MAX_TRACKED_REPLIES) {
        this.expectedEchoes.shift()
      }
      return true
    } catch {
      // Why splice by identity, not pop: the write above can re-enter onData and
      // retire a different projection, so the last slot is not necessarily ours.
      const index = expected ? this.expectedEchoes.indexOf(expected) : -1
      if (index !== -1) {
        this.expectedEchoes.splice(index, 1)
      }
      onFailed?.()
      return false
    }
  }
}
