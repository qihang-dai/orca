import type { PtyStartupReplyDelivery } from './pty-startup-reply-delivery'
import {
  extractOnlyTerminalQueryReplies,
  needsCookedEchoSafeQueryReply
} from './terminal-query-reply'

export function deliverTerminalQueryReplyPayload(
  data: string,
  delivery: Pick<PtyStartupReplyDelivery, 'answer' | 'answerInOrder'>
): boolean {
  const replies = extractOnlyTerminalQueryReplies(data)
  if (!replies) {
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
