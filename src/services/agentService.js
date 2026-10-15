
// //src/services/agentService.js
// import { HumanMessage } from '@langchain/core/messages';
// import { graph } from '../graph/index.js';
// import { UserProfile } from '../models/UserProfile.js';
// import { logger } from '../utils/logger.js';
// import { registerSink, clearSink } from '../agents/sentenceSink.js';

// // ── Profile hydration ─────────────────────────────────────────────────────────

// // Memory keys that describe the person and should follow them across calls.
// // Deliberately excludes `date` and `time`: those belong to one specific booking,
// // and replaying last month's slot into this call's context makes the agent
// // confidently wrong ("so, tomorrow at 3 as usual?").
// const DURABLE_KEYS = ['name', 'email'];

// /**
//  * Describe which index rejected a duplicate-key write.
//  *
//  * `err.keyPattern` is the clean source, but it is not always populated — it
//  * came back empty from a Mongoose `save()` in the field, which turned a useful
//  * message into "unique index on []". The driver always puts the index name in
//  * the message text, so parse that as a fallback.
//  *
//  * @returns {{ fields: string[], label: string, isPhoneNumber: boolean }}
//  */
// function describeDuplicateKey(err) {
//   const fields = Object.keys(err?.keyPattern ?? {});
//   if (fields.length) {
//     return {
//       fields,
//       label: fields.join(', '),
//       isPhoneNumber: fields.includes('phoneNumber'),
//     };
//   }

//   // e.g. "... index: whatsappNumber_1 dup key: { whatsappNumber: null }"
//   const name = /index:\s*([^\s]+)/.exec(err?.message ?? '')?.[1];
//   if (name) {
//     // Index names are field_direction, possibly compound: "a_1_b_-1".
//     const guessed = name.replace(/_-?1$/, '').split(/_-?1_/);
//     return {
//       fields: guessed,
//       label: `${guessed.join(', ')} (index "${name}")`,
//       isPhoneNumber: guessed.includes('phoneNumber'),
//     };
//   }

//   return { fields: [], label: 'unknown index', isPhoneNumber: false };
// }

// /**
//  * Flatten a profile's `memory` array into a plain object.
//  * `memory` is [{ key, value, updatedAt }], newest write wins.
//  */
// function memoryToObject(memory = []) {
//   const out = {};
//   for (const m of memory) {
//     if (m?.key && m.value != null && m.value !== '') out[m.key] = m.value;
//   }
//   return out;
// }

// /**
//  * Load (or create) a caller's UserProfile, keyed on phone number.
//  *
//  * Uses a single upsert rather than findOne-then-create. That is atomic, so two
//  * simultaneous calls from the same number cannot race into a duplicate insert,
//  * and it means the common "returning caller" path is one round trip.
//  *
//  * Always resolves — a database problem degrades the call (no memory) rather
//  * than breaking it. The returned object carries `degraded` so the caller can
//  * tell "new caller" apart from "we could not read the database", which the old
//  * version silently conflated.
//  *
//  * @returns {Promise<{
//  *   phoneNumber: string, name: string|null, email: string|null,
//  *   memory: Array, callCount: number, lastCallAt: Date|null,
//  *   isReturning: boolean, degraded: boolean
//  * }>}
//  */
// export async function hydrateUserProfile(phoneNumber) {
//   const blank = {
//     phoneNumber,
//     name: null,
//     email: null,
//     memory: [],
//     callCount: 0,
//     lastCallAt: null,
//     isReturning: false,
//     degraded: false,
//   };

//   if (!phoneNumber || phoneNumber === 'unknown') {
//     logger.warn('[agentService] no caller number — running without a profile');
//     return { ...blank, degraded: true };
//   }

//   const shape = (doc) => {
//     const mem = memoryToObject(doc.memory);
//     return {
//       ...blank,
//       ...doc,
//       // Top-level columns are authoritative; fall back to whatever an older
//       // build stashed in `memory` so existing records still hydrate.
//       name: doc.name ?? mem.name ?? null,
//       email: doc.email ?? mem.email ?? null,
//       memory: doc.memory ?? [],
//       callCount: doc.callCount ?? 0,
//       isReturning: (doc.callCount ?? 0) > 0,
//       degraded: false,
//     };
//   };

//   try {
//     const doc = await UserProfile.findOneAndUpdate(
//       { phoneNumber },
//       { $setOnInsert: { phoneNumber } },
//       { upsert: true, new: true, setDefaultsOnInsert: true },
//     ).lean();

//     const profile = shape(doc);
//     logger.info(
//       `[agentService] profile ${profile.isReturning ? 'loaded' : 'created'} for ${phoneNumber}`,
//       { name: profile.name, email: profile.email, callCount: profile.callCount },
//     );
//     return profile;
//   } catch (err) {
//     // 11000 on an upsert means a unique index rejected the write. If the
//     // offending index is not on phoneNumber, it is a leftover index on a field
//     // this schema no longer defines — every new caller will hit it, because
//     // MongoDB indexes all absent values as the same null.
//     if (err.code === 11000) {
//       const dup = describeDuplicateKey(err);
//       if (dup.fields.length && !dup.isPhoneNumber) {
//         logger.error(
//           `[agentService] STALE UNIQUE INDEX on [${dup.label}] is blocking profile ` +
//           `creation. Lead data will NOT be saved for new callers. ` +
//           `Fix: node scripts/fix-indexes.js --drop`,
//         );
//       } else {
//         // Genuine race: another call inserted between our upsert's read and
//         // write. The document exists now, so just read it.
//         const doc = await UserProfile.findOne({ phoneNumber }).lean().catch(() => null);
//         if (doc) return shape(doc);
//       }
//     } else {
//       logger.error(`[agentService] hydrateUserProfile error: ${err.message}`);
//     }
//     return { ...blank, degraded: true };
//   }
// }

// /**
//  * Seed this call's leadData from what we already know about the caller, so the
//  * agent does not ask a returning caller for their name and email again.
//  */
// export function leadDataFromProfile(profile) {
//   const mem = memoryToObject(profile?.memory);
//   const seed = { name: null, email: null, date: null, time: null };
//   for (const key of DURABLE_KEYS) {
//     const value = profile?.[key] ?? mem[key] ?? null;
//     if (value) seed[key] = value;
//   }
//   return seed;
// }

// /**
//  * Long-term context string handed to the agent as `userSummary`.
//  * Returns null for a caller we know nothing about, so the prompt renders
//  * "new caller" rather than an empty heading.
//  */
// export function buildUserSummary(profile) {
//   if (!profile || profile.degraded) return null;

//   const lines = [];
//   if (profile.name) lines.push(`Name: ${profile.name}`);
//   if (profile.email) lines.push(`Email: ${profile.email}`);
//   if (profile.callCount > 0) {
//     const when = profile.lastCallAt
//       ? new Date(profile.lastCallAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })
//       : 'previously';
//     lines.push(`Previous calls: ${profile.callCount} (last on ${when})`);
//   }

//   // Anything else remembered that is not already stated above.
//   const mem = memoryToObject(profile.memory);
//   for (const [k, v] of Object.entries(mem)) {
//     if (['name', 'email', 'date', 'time'].includes(k)) continue;
//     lines.push(`${k}: ${v}`);
//   }

//   return lines.length ? lines.join('\n') : null;
// }

// // ── Message processing ────────────────────────────────────────────────────────

// /**
//  * Run one caller utterance through the LangGraph graph.
//  *
//  * State shape (must match state.js):
//  *   messages     — HumanMessage appended each turn
//  *   userSummary  — long-term memory string from MongoDB (set once at session start)
//  *   leadData     — name/email/date/time accumulated across turns
//  *
//  * @param {string}   sessionId    - Twilio callSid (MemorySaver thread_id)
//  * @param {string}   transcript   - Caller's spoken text for this turn
//  * @param {object}   userProfile  - Plain MongoDB document (has .memory array)
//  * @param {object}   leadData     - Current leadData accumulated so far this call
//  * @param {object}   [opts]
//  * @param {function} [opts.onSentence] - Called with each speakable segment the
//  *        moment it is complete, while the model is still generating the rest.
//  *        Supply this and the caller can start TTS long before the turn ends;
//  *        omit it and this behaves exactly like the old blocking version.
//  * @returns {Promise<{ response: string, agentName: string, latencyMs: number }>}
//  */
// export async function processMessage(
//   sessionId,
//   transcript,
//   userProfile,
//   leadData = {},
//   { onSentence, replyLanguage = null, turnId = null } = {},
// ) {
//   const t0 = Date.now();

//   const userSummary = buildUserSummary(userProfile);

//   const stateUpdate = {
//     // Tagged with the turn id so the node can leave this turn out of the
//     // model's view if the session later drops it unheard.
//     messages: [new HumanMessage({ content: transcript, additional_kwargs: { turnId } })],
//     userSummary,          // string | null — Rahul reads this as long-term context
//     leadData,             // pass current accumulated lead data so Rahul can merge
//   };

//   if (onSentence) registerSink(sessionId, onSentence);

//   try {
//     const graphStart = Date.now();
//     const finalState = await graph.invoke(
//       stateUpdate,
//       {
//         // replyLanguage is decided by the session from what the caller has
//         // actually said, and handed to the node as a fact rather than left for
//         // the model to guess each turn.
//         configurable: { thread_id: sessionId, replyLanguage, turnId },
//         // Each agent -> tool -> agent round is ~2 steps. A tool that keeps
//         // failing (a schema mismatch retried three times was seen on a live
//         // call) would otherwise loop to LangGraph's default of 25 while the
//         // caller hears nothing. 12 allows ~5 genuine tool rounds.
//         recursionLimit: Number(process.env.GRAPH_RECURSION_LIMIT ?? 12),
//       },
//     );
//     logger.info(`[LATENCY] graph.invoke = ${Date.now() - graphStart} ms`);

//     const latencyMs = Date.now() - t0;

//     // Response is always the last message in the messages array
//     const lastMsg = finalState.messages[finalState.messages.length - 1];
//     const response = typeof lastMsg?.content === 'string' && lastMsg.content.trim()
//       ? lastMsg.content.trim()
//       : "I'm sorry, could you say that again?";

//     // leadData may have been updated by the extractor inside rahulNode
//     const updatedLeadData = finalState.leadData ?? leadData;

//     logger.info(`[agentService] sessionId=${sessionId} latency=${latencyMs}ms`);

//     return {
//       response,
//       agentName: 'rahul',       // always rahul — single agent
//       latencyMs,
//       leadData: updatedLeadData,
//       // True when the sentences were already handed to the caller mid-stream,
//       // so the caller knows not to speak `response` a second time.
//       streamed: Boolean(onSentence),
//     };
//   } catch (err) {
//     logger.error(`[agentService] processMessage error: ${err.message}`);

//     // Nothing was spoken this turn, so say something rather than leave the
//     // caller in silence — in their language, and the SAME words go in the
//     // transcript, so the log matches what they actually heard.
//     const fallback = /[\u0900-\u097F]/.test(String(transcript))
//       ? 'माफ़ कीजिए, एक छोटी सी दिक्कत आ गई। क्या आप दोबारा बता सकते हैं?'
//       : 'Sorry, something went wrong on my side. Could you say that again?';
//     if (onSentence) onSentence(fallback);
//     return {
//       response: fallback,
//       agentName: 'rahul',
//       latencyMs: Date.now() - t0,
//       leadData,
//       streamed: false,
//     };
//   } finally {
//     clearSink(sessionId);
//   }
// }

// // ── Memory persistence ────────────────────────────────────────────────────────

// /**
//  * Write what we learned this call back to the caller's profile.
//  *
//  * The old version did findOne -> if (!profile) return, which meant that
//  * whenever profile creation had failed at the start of the call, every lead
//  * captured during it was discarded without a word. This upserts instead, so a
//  * transient problem at pickup no longer costs you the lead.
//  *
//  * `name` and `email` are written to their real columns (they are in the schema
//  * and were never being populated) as well as into `memory`, so both the old and
//  * new read paths see them.
//  *
//  * @param {string} phoneNumber
//  * @param {object} leadData  - { name, email, date, time, ... }
//  */
// export async function persistLeadData(phoneNumber, leadData) {
//   if (!phoneNumber || phoneNumber === 'unknown') return;
//   if (!leadData || !Object.values(leadData).some(Boolean)) {
//     logger.info(`[agentService] nothing captured for ${phoneNumber} — skipping write`);
//     return;
//   }

//   try {
//     const profile =
//       (await UserProfile.findOne({ phoneNumber })) ??
//       new UserProfile({ phoneNumber });

//     for (const [key, value] of Object.entries(leadData)) {
//       if (!value) continue;
//       profile.upsertMemory(key, value);
//       // Promote the durable identity fields to real columns.
//       if (DURABLE_KEYS.includes(key)) profile[key] = value;
//     }

//     profile.lastCallAt = new Date();
//     profile.callCount = (profile.callCount ?? 0) + 1;

//     await profile.save();
//     logger.info(`[agentService] persisted lead data for ${phoneNumber}`, leadData);
//   } catch (err) {
//     if (err.code === 11000) {
//       const dup = describeDuplicateKey(err);
//       logger.error(
//         `[agentService] LEAD DATA LOST for ${phoneNumber} — unique index on ` +
//         `[${dup.label}] rejected the write. Captured: ${JSON.stringify(leadData)}`,
//       );
//     } else {
//       logger.error(
//         `[agentService] persistLeadData error: ${err.message} — captured: ${JSON.stringify(leadData)}`,
//       );
//     }
//   }
// }







//src/services/agentService.js
import { HumanMessage } from '@langchain/core/messages';
import { graph } from '../graph/index.js';
import { UserProfile } from '../models/UserProfile.js';
import { logger } from '../utils/logger.js';
import { registerSink, clearSink } from '../agents/sentenceSink.js';

// ── Profile hydration ─────────────────────────────────────────────────────────

// Memory keys that describe the person and should follow them across calls.
// Deliberately excludes `date` and `time`: those belong to one specific booking,
// and replaying last month's slot into this call's context makes the agent
// confidently wrong ("so, tomorrow at 3 as usual?").
const DURABLE_KEYS = ['name', 'email'];

/**
 * Describe which index rejected a duplicate-key write.
 *
 * `err.keyPattern` is the clean source, but it is not always populated — it
 * came back empty from a Mongoose `save()` in the field, which turned a useful
 * message into "unique index on []". The driver always puts the index name in
 * the message text, so parse that as a fallback.
 *
 * @returns {{ fields: string[], label: string, isPhoneNumber: boolean }}
 */
function describeDuplicateKey(err) {
  const fields = Object.keys(err?.keyPattern ?? {});
  if (fields.length) {
    return {
      fields,
      label: fields.join(', '),
      isPhoneNumber: fields.includes('phoneNumber'),
    };
  }

  // e.g. "... index: whatsappNumber_1 dup key: { whatsappNumber: null }"
  const name = /index:\s*([^\s]+)/.exec(err?.message ?? '')?.[1];
  if (name) {
    // Index names are field_direction, possibly compound: "a_1_b_-1".
    const guessed = name.replace(/_-?1$/, '').split(/_-?1_/);
    return {
      fields: guessed,
      label: `${guessed.join(', ')} (index "${name}")`,
      isPhoneNumber: guessed.includes('phoneNumber'),
    };
  }

  return { fields: [], label: 'unknown index', isPhoneNumber: false };
}

/**
 * Flatten a profile's `memory` array into a plain object.
 * `memory` is [{ key, value, updatedAt }], newest write wins.
 */
function memoryToObject(memory = []) {
  const out = {};
  for (const m of memory) {
    if (m?.key && m.value != null && m.value !== '') out[m.key] = m.value;
  }
  return out;
}

/**
 * Load (or create) a caller's UserProfile, keyed on phone number.
 *
 * Uses a single upsert rather than findOne-then-create. That is atomic, so two
 * simultaneous calls from the same number cannot race into a duplicate insert,
 * and it means the common "returning caller" path is one round trip.
 *
 * Always resolves — a database problem degrades the call (no memory) rather
 * than breaking it. The returned object carries `degraded` so the caller can
 * tell "new caller" apart from "we could not read the database", which the old
 * version silently conflated.
 *
 * @returns {Promise<{
 *   phoneNumber: string, name: string|null, email: string|null,
 *   memory: Array, callCount: number, lastCallAt: Date|null,
 *   isReturning: boolean, degraded: boolean
 * }>}
 */
export async function hydrateUserProfile(phoneNumber) {
  const blank = {
    phoneNumber,
    name: null,
    email: null,
    memory: [],
    callCount: 0,
    lastCallAt: null,
    isReturning: false,
    degraded: false,
  };

  if (!phoneNumber || phoneNumber === 'unknown') {
    logger.warn('[agentService] no caller number — running without a profile');
    return { ...blank, degraded: true };
  }

  const shape = (doc) => {
    const mem = memoryToObject(doc.memory);
    return {
      ...blank,
      ...doc,
      // Top-level columns are authoritative; fall back to whatever an older
      // build stashed in `memory` so existing records still hydrate.
      name: doc.name ?? mem.name ?? null,
      email: doc.email ?? mem.email ?? null,
      memory: doc.memory ?? [],
      callCount: doc.callCount ?? 0,
      isReturning: (doc.callCount ?? 0) > 0,
      degraded: false,
    };
  };

  try {
    const doc = await UserProfile.findOneAndUpdate(
      { phoneNumber },
      { $setOnInsert: { phoneNumber } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();

    const profile = shape(doc);
    logger.info(
      `[agentService] profile ${profile.isReturning ? 'loaded' : 'created'} for ${phoneNumber}`,
      { name: profile.name, email: profile.email, callCount: profile.callCount },
    );
    return profile;
  } catch (err) {
    // 11000 on an upsert means a unique index rejected the write. If the
    // offending index is not on phoneNumber, it is a leftover index on a field
    // this schema no longer defines — every new caller will hit it, because
    // MongoDB indexes all absent values as the same null.
    if (err.code === 11000) {
      const dup = describeDuplicateKey(err);
      if (dup.fields.length && !dup.isPhoneNumber) {
        logger.error(
          `[agentService] STALE UNIQUE INDEX on [${dup.label}] is blocking profile ` +
          `creation. Lead data will NOT be saved for new callers. ` +
          `Fix: node scripts/fix-indexes.js --drop`,
        );
      } else {
        // Genuine race: another call inserted between our upsert's read and
        // write. The document exists now, so just read it.
        const doc = await UserProfile.findOne({ phoneNumber }).lean().catch(() => null);
        if (doc) return shape(doc);
      }
    } else {
      logger.error(`[agentService] hydrateUserProfile error: ${err.message}`);
    }
    return { ...blank, degraded: true };
  }
}

/**
 * Seed this call's leadData from what we already know about the caller, so the
 * agent does not ask a returning caller for their name and email again.
 */
export function leadDataFromProfile(profile) {
  const mem = memoryToObject(profile?.memory);
  const seed = { name: null, email: null, date: null, time: null };
  for (const key of DURABLE_KEYS) {
    const value = profile?.[key] ?? mem[key] ?? null;
    if (value) seed[key] = value;
  }
  return seed;
}

/**
 * Long-term context string handed to the agent as `userSummary`.
 * Returns null for a caller we know nothing about, so the prompt renders
 * "new caller" rather than an empty heading.
 */
export function buildUserSummary(profile) {
  if (!profile || profile.degraded) return null;

  const lines = [];
  if (profile.name) lines.push(`Name: ${profile.name}`);
  if (profile.email) lines.push(`Email: ${profile.email}`);
  if (profile.callCount > 0) {
    const when = profile.lastCallAt
      ? new Date(profile.lastCallAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })
      : 'previously';
    lines.push(`Previous calls: ${profile.callCount} (last on ${when})`);
  }

  // Anything else remembered that is not already stated above.
  const mem = memoryToObject(profile.memory);
  for (const [k, v] of Object.entries(mem)) {
    if (['name', 'email', 'date', 'time'].includes(k)) continue;
    lines.push(`${k}: ${v}`);
  }

  return lines.length ? lines.join('\n') : null;
}

// ── Message processing ────────────────────────────────────────────────────────

/**
 * Run one caller utterance through the LangGraph graph.
 *
 * State shape (must match state.js):
 *   messages     — HumanMessage appended each turn
 *   userSummary  — long-term memory string from MongoDB (set once at session start)
 *   leadData     — name/email/date/time accumulated across turns
 *
 * @param {string}   sessionId    - Twilio callSid (MemorySaver thread_id)
 * @param {string}   transcript   - Caller's spoken text for this turn
 * @param {object}   userProfile  - Plain MongoDB document (has .memory array)
 * @param {object}   leadData     - Current leadData accumulated so far this call
 * @param {object}   [opts]
 * @param {function} [opts.onSentence] - Called with each speakable segment the
 *        moment it is complete, while the model is still generating the rest.
 *        Supply this and the caller can start TTS long before the turn ends;
 *        omit it and this behaves exactly like the old blocking version.
 * @returns {Promise<{ response: string, agentName: string, latencyMs: number }>}
 */
export async function processMessage(
  sessionId,
  transcript,
  userProfile,
  leadData = {},
  { onSentence, replyLanguage = null, turnId = null } = {},
) {
  const t0 = Date.now();

  const userSummary = buildUserSummary(userProfile);

  const stateUpdate = {
    // Tagged with the turn id so the node can leave this turn out of the
    // model's view if the session later drops it unheard.
    messages: [new HumanMessage({ content: transcript, additional_kwargs: { turnId } })],
    userSummary,          // string | null — Rahul reads this as long-term context
    leadData,             // pass current accumulated lead data so Rahul can merge
  };

  if (onSentence) registerSink(sessionId, onSentence);

  try {
    const graphStart = Date.now();
    const finalState = await graph.invoke(
      stateUpdate,
      {
        // replyLanguage is decided by the session from what the caller has
        // actually said, and handed to the node as a fact rather than left for
        // the model to guess each turn.
        configurable: { thread_id: sessionId, replyLanguage, turnId },
        // Each agent -> tool -> agent round is ~2 steps. A tool that keeps
        // failing (a schema mismatch retried three times was seen on a live
        // call) would otherwise loop to LangGraph's default of 25 while the
        // caller hears nothing. 12 allows ~5 genuine tool rounds.
        recursionLimit: Number(process.env.GRAPH_RECURSION_LIMIT ?? 12),
      },
    );
    logger.info(`[LATENCY] graph.invoke = ${Date.now() - graphStart} ms`);

    const latencyMs = Date.now() - t0;

    // Response is always the last message in the messages array
    const lastMsg = finalState.messages[finalState.messages.length - 1];
    const response = typeof lastMsg?.content === 'string' && lastMsg.content.trim()
      ? lastMsg.content.trim()
      : "I'm sorry, could you say that again?";

    // leadData may have been updated by the extractor inside rahulNode
    const updatedLeadData = finalState.leadData ?? leadData;

    logger.info(`[agentService] sessionId=${sessionId} latency=${latencyMs}ms`);

    return {
      response,
      agentName: 'rahul',       // always rahul — single agent
      latencyMs,
      leadData: updatedLeadData,
      // True when the sentences were already handed to the caller mid-stream,
      // so the caller knows not to speak `response` a second time.
      streamed: Boolean(onSentence),
    };
  } catch (err) {
    logger.error(`[agentService] processMessage error: ${err.message}`);

    // Nothing was spoken this turn, so say something rather than leave the
    // caller in silence — in their language, and the SAME words go in the
    // transcript, so the log matches what they actually heard.
    // The reply language the session decided, not the script of this one
    // transcript — otherwise an English call can hear a Hindi apology.
    const fallback = replyLanguage === 'hi'
      ? 'माफ़ कीजिए, एक छोटी सी दिक्कत आ गई। क्या आप दोबारा बता सकते हैं?'
      : 'Sorry, something went wrong on my side. Could you say that again?';
    if (onSentence) onSentence(fallback);
    return {
      response: fallback,
      agentName: 'rahul',
      latencyMs: Date.now() - t0,
      leadData,
      streamed: false,
    };
  } finally {
    clearSink(sessionId);
  }
}

// ── Memory persistence ────────────────────────────────────────────────────────

/**
 * Write what we learned this call back to the caller's profile.
 *
 * The old version did findOne -> if (!profile) return, which meant that
 * whenever profile creation had failed at the start of the call, every lead
 * captured during it was discarded without a word. This upserts instead, so a
 * transient problem at pickup no longer costs you the lead.
 *
 * `name` and `email` are written to their real columns (they are in the schema
 * and were never being populated) as well as into `memory`, so both the old and
 * new read paths see them.
 *
 * @param {string} phoneNumber
 * @param {object} leadData  - { name, email, date, time, ... }
 */
export async function persistLeadData(phoneNumber, leadData) {
  if (!phoneNumber || phoneNumber === 'unknown') return;
  if (!leadData || !Object.values(leadData).some(Boolean)) {
    logger.info(`[agentService] nothing captured for ${phoneNumber} — skipping write`);
    return;
  }

  try {
    const profile =
      (await UserProfile.findOne({ phoneNumber })) ??
      new UserProfile({ phoneNumber });

    for (const [key, value] of Object.entries(leadData)) {
      if (!value) continue;
      profile.upsertMemory(key, value);
      // Promote the durable identity fields to real columns.
      if (DURABLE_KEYS.includes(key)) profile[key] = value;
    }

    profile.lastCallAt = new Date();
    profile.callCount = (profile.callCount ?? 0) + 1;

    await profile.save();
    logger.info(`[agentService] persisted lead data for ${phoneNumber}`, leadData);
  } catch (err) {
    if (err.code === 11000) {
      const dup = describeDuplicateKey(err);
      logger.error(
        `[agentService] LEAD DATA LOST for ${phoneNumber} — unique index on ` +
        `[${dup.label}] rejected the write. Captured: ${JSON.stringify(leadData)}`,
      );
    } else {
      logger.error(
        `[agentService] persistLeadData error: ${err.message} — captured: ${JSON.stringify(leadData)}`,
      );
    }
  }
}