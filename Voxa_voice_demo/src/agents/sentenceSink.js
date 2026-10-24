// src/agents/sentenceSink.js
//
// A tiny registry that lets a LangGraph node push text OUT of the graph while
// it is still running.
//
// Why not just put the callback in `config.configurable`? Because that object
// is handed to the checkpointer (MemorySaver) and gets persisted/copied as
// graph metadata. Functions do not belong there. A thread_id -> callback map
// living outside the graph keeps the config plain-JSON and avoids any
// serialization surprises if the checkpointer is ever swapped for Redis/Mongo.
//
// Lifecycle: registerSink() before graph.invoke(), clearSink() in a finally.

const sinks = new Map();

/**
 * @param {string} threadId  Twilio callSid — same value used as LangGraph thread_id
 * @param {(sentence: string) => void} fn
 */
export function registerSink(threadId, fn) {
  if (!threadId || typeof fn !== 'function') return;
  sinks.set(threadId, fn);
}

export function clearSink(threadId) {
  sinks.delete(threadId);
}

/**
 * Returns a *safe* emitter — never throws into the LLM stream loop, and is a
 * no-op when nothing is registered (so the graph still works when invoked
 * from a non-streaming context such as a test or an HTTP endpoint).
 */
export function getSink(threadId) {
  const fn = sinks.get(threadId);
  if (!fn) return () => {};
  return (sentence) => {
    try {
      fn(sentence);
    } catch {
      /* a failing consumer must never abort token streaming */
    }
  };
}
