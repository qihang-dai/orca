import type { PtyStartupReplyDelivery } from './pty-startup-reply-delivery'
import {
  extractOnlyTerminalQueryReplies,
  needsCookedEchoSafeQueryReply
} from './terminal-query-reply'

/**
 * True when `delivery` has taken ownership of the WHOLE payload.
 *
 * All-or-nothing on purpose. Taking only part of it would drop the rest — the caller
 * has already been told the write was handled — and taking a payload that needs no
 * ordering at all would skip the caller's own queues. The daemon's post-ready flush
 * gate is the one that matters: a CPR written past it lands ahead of the buffered
 * startup command and the shell executes the spliced remainder instead of the command.
 */
export function deliverTerminalQueryReplyPayload(
  data: string,
  delivery: Pick<PtyStartupReplyDelivery, 'answer' | 'answerInOrder' | 'hasDeferredWrites'>
): boolean {
  const replies = extractOnlyTerminalQueryReplies(data)
  if (!replies) {
    return false
  }
  // Nothing here needs echo containment and nothing is deferred, so there is nothing to
  // order behind: leave it on the caller's path.
  if (!delivery.hasDeferredWrites && !replies.some(needsCookedEchoSafeQueryReply)) {
    return false
  }
  let accepted = false
  for (const reply of replies) {
    const handled = needsCookedEchoSafeQueryReply(reply)
      ? delivery.answer(reply)
      : delivery.answerInOrder(reply)
    accepted = handled || accepted
  }
  return accepted
}
