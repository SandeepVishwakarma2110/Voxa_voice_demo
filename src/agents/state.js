// src/agents/state.js
import { Annotation } from '@langchain/langgraph';

export const AgentState = Annotation.Root({
  // Full conversation history — appended each turn
  messages: Annotation({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),

  // Long-term memory summary loaded from DB at session start
  userSummary: Annotation({
    reducer: (_x, y) => y,
    default: () => null,
  }),

  // Lead data extracted progressively throughout the call
  // Reducer merges so partial updates don't wipe existing fields
  leadData: Annotation({
    reducer: (x, y) => ({ ...x, ...y }),
    default: () => ({ name: null, email: null, date: null, time: null }),
  }),
});