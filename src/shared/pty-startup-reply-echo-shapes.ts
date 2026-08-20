import type { PtyOwnerBackend } from './pty-owner-backend'

// The shapes a reply written to the PTY master can come back as, and how one is located
// inside a coalesced read. Split from the delivery scheduler (#12112, #13137): what an
// echo LOOKS like is independent of when the write happens.

export type PtyStartupReplyEchoMatch =
  | { kind: 'complete'; offset: number; length: number }
  | { kind: 'partial'; offset: number }
  | { kind: 'none' }

export function replyEchoProjections(
  reply: string,
  ownerBackend: PtyOwnerBackend,
  kernelEchoImpossible: boolean
): readonly string[] {
  if (ownerBackend === 'windows-conpty') {
    // Why: ConPTY's projection is the documented, deterministic ESC-stripped form.
    return [reply.replaceAll('\x1b', '')]
  }
  if (ownerBackend !== 'posix-pty') {
    // wsl.exe is ConPTY-hosted but its echo shape is unverified; suppress nothing.
    return []
  }
  // What makes both shapes below safe to match on is that neither starts with ESC, so
  // no query can share a prefix with them. The verbatim echo of a `stty -echoctl` tty
  // is deliberately NOT projected for exactly that reason: it is byte-identical to the
  // reply, so a bare trailing ESC — how any read can end — is a strict prefix of it.
  // That read would be held as an echo candidate, and an expired hold releases its
  // bytes raw, past the query parser, so a query torn at its own ESC is never answered.
  const projections: string[] = []
  // A quiet probe rules out only the kernel's ECHOCTL caret form.
  if (!kernelEchoImpossible) {
    projections.push(reply.replaceAll('\x1b', '^['))
  }
  // Readline rewrites OSC, while adding a CSI identity would hold query fragments.
  if (reply.includes('\x1b]')) {
    projections.push(reply.replaceAll('\x1b]', '\x07').replaceAll('\x1b\\', ''))
  }
  return projections
}

/** Earliest offset whose suffix of `data` is a strict prefix of `projection`, else -1. */
function suffixPrefixOffset(projection: string, data: string): number {
  for (
    let offset = Math.max(0, data.length - projection.length + 1);
    offset < data.length;
    offset += 1
  ) {
    if (projection.startsWith(data.slice(offset))) {
      return offset
    }
  }
  return -1
}

// Why search the whole span: the tty coalesces its echo with whatever the shell and the
// program wrote around it, so anchoring at offset 0 recognizes almost no real echo.
export function locateEcho(projections: readonly string[], data: string): PtyStartupReplyEchoMatch {
  let complete: { offset: number; length: number } | null = null
  let partialOffset = -1
  for (const projection of projections) {
    const at = data.indexOf(projection)
    if (at !== -1) {
      if (!complete || at < complete.offset) {
        complete = { offset: at, length: projection.length }
      }
      continue
    }
    const suffix = suffixPrefixOffset(projection, data)
    if (suffix !== -1 && (partialOffset === -1 || suffix < partialOffset)) {
      partialOffset = suffix
    }
  }
  if (complete) {
    return { kind: 'complete', ...complete }
  }
  return partialOffset === -1 ? { kind: 'none' } : { kind: 'partial', offset: partialOffset }
}

export function isBetterEchoMatch(
  candidate: PtyStartupReplyEchoMatch,
  best: PtyStartupReplyEchoMatch
): boolean {
  if (candidate.kind === 'none') {
    return false
  }
  if (best.kind === 'none') {
    return true
  }
  if (candidate.kind !== best.kind) {
    return candidate.kind === 'complete'
  }
  return candidate.offset < best.offset
}
