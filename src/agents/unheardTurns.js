// src/agents/unheardTurns.js
//
// Turns the caller NEVER HEARD, so the model can be kept from believing it
// said them.
//
// A reply is dropped when the caller keeps talking before it starts playing.
// The audio is discarded, but LangGraph has already checkpointed the reply, so
// the model "remembers" saying it. On a live call the final "बुक कर दूँ?" was
// written, dropped and never spoken — and when the caller's next utterance
// contained a stray "Yes." (actually the letter S, misheard mid-spelling), the
// model took it as agreement and booked the meeting with an email the caller
// was in the middle of correcting.
//
// Rather than edit the checkpoint (which depends on the state reducer), every
// message is tagged with its turn id, and the agent node filters out any turn
// recorded here before calling the model.

const unheard = new Map();   // threadId -> Set<turnId>

export function markTurnUnheard(threadId, turnId) {
  if (!threadId || !turnId) return;
  if (!unheard.has(threadId)) unheard.set(threadId, new Set());
  unheard.get(threadId).add(turnId);
}

export function unheardTurns(threadId) {
  return unheard.get(threadId) ?? new Set();
}

/** Call when the session ends, so the map does not grow with every call. */
export function clearUnheardTurns(threadId) {
  unheard.delete(threadId);
}

/**
 * The conversation as the caller actually experienced it: every message from
 * an unheard turn is removed, along with any tool results that belong to a
 * removed tool call (OpenAI rejects a tool result without its call).
 */
export function withoutUnheard(messages, threadId) {
  const skip = unheardTurns(threadId);
  if (!skip.size) return messages;

  const droppedCalls = new Set();
  return messages.filter((m) => {
    const turnId = m?.additional_kwargs?.turnId;
    if (turnId && skip.has(turnId)) {
      for (const tc of m.tool_calls ?? []) if (tc.id) droppedCalls.add(tc.id);
      return false;
    }
    if (m?.tool_call_id && droppedCalls.has(m.tool_call_id)) return false;
    return true;
  });
}