// // src/agents/companyAgents.js
// import { ChatOpenAI } from '@langchain/openai';
// import { AIMessage } from '@langchain/core/messages';
// import { checkAvailabilityTool, bookAppointmentTool } from '../tools/calendar.js';
// import { sendMeetingEmailTool } from '../tools/email.js';
// import { RAHUL_PERSONA } from '../constants/prompts.js';
// import { logger } from '../utils/logger.js';
// import { config } from '../config/index.js';
// import { getSink } from './sentenceSink.js';
// import { fillerFor } from '../constants/fillers.js';
// import { withoutUnheard } from './unheardTurns.js';
// import { assessBookingPermit, sameEmail } from './bookingGuard.js';
// import { createSentenceChunker } from '../services/speechService.js';

// // ─────────────────────────────────────────────────────────────────────────────
// // Model setup
// // ─────────────────────────────────────────────────────────────────────────────

// const llm = new ChatOpenAI({
//   model: 'gpt-4o-mini',
//   temperature: 0.3,
 
//   maxTokens: 120,
 
//   timeout: Number(process.env.LLM_TIMEOUT_MS ?? 12_000),
//   maxRetries: 1,
//   modelKwargs: {
//     presence_penalty: 0,
//     frequency_penalty: 0,
//   },
// });

// const extractLeadDataTool = {
//   type: 'function',
//   function: {
//     name: 'extract_lead_data',
//     description: 'Call this silently to save caller\'s name, email, date, or time when stated in English, Hindi, or Hinglish (e.g. "kal 3 baje", "Mera naam Amit hai").',
//     parameters: {
//       type: 'object',
//       properties: {
//         name: { type: 'string' },
//         email: { type: 'string' },
//         date: { type: 'string', description: 'Format as YYYY-MM-DD if possible' },
//         time: { type: 'string', description: 'Format as HH:MM AM/PM' },
//       },
//     },
//   },
// };

// const rahulWithTools = llm.bindTools([
//   checkAvailabilityTool,
//   bookAppointmentTool,
//   sendMeetingEmailTool,
//   extractLeadDataTool,
// ]);


// const SILENT_TOOL = 'extract_lead_data';

// const REFUSAL_RE =
//   /सिर्फ़?\s*Xverse\s*के\s*बारे|only\s+(?:help|talk|assist)\s+(?:you\s+)?with\s+Xverse|can\s+only\s+(?:help|talk|assist)|मैं\s+सिर्फ़?\s+.*मदद\s+कर\s+सकती/i;

// const IN_SCOPE_RE =
//   /priya|प्रिया|xverse|एक्सवर्स|your\s+name|आपका\s+नाम|तुम्हारा\s+नाम|who\s+are\s+you|आप\s+कौन|are\s+you\s+(?:a\s+)?(?:bot|robot|human|ai)|company|कंपनी|कम्पनी|product|प्रोडक्ट|meeting|मीटिंग|book|बुक|price|कीमत|website|वेबसाइट|xmed|voxa|botique|consult|\bAI\b|\bmean\b|मतलब|matlab|more\s+about|और\s+बताओ|और\s+बताइए/i;


// function recentAgentTexts(messages, n) {
//   const out = [];
//   for (let i = messages.length - 1; i >= 0 && out.length < n; i--) {
//     const m = messages[i];
//     const type = m?._getType?.() ?? m?.getType?.() ?? m?.role;
//     if (type === 'ai' || type === 'assistant') out.push(contentToText(m.content ?? ''));
//   }
//   return out;
// }


// function extractBookedFromMessages(messages) {

//   for (let i = messages.length - 1; i >= 0; i--) {
//     const content = messages[i]?.content;
//     if (typeof content !== 'string') continue;
//     const m = /\[\[BOOKED:(\{.*?\})\]\]/s.exec(content);
//     if (!m) continue;
//     try {
//       const booked = JSON.parse(m[1]);
//       const out = {};
//       for (const key of ['date', 'time', 'eventId', 'name', 'email']) {
//         if (booked[key]) out[key] = booked[key];
//       }
//       return Object.keys(out).length ? out : null;
//     } catch {
//       return null;  
//     }
//   }
//   return null;
// }

// function contentToText(content) {
//   if (typeof content === 'string') return content;
//   if (Array.isArray(content)) {
//     return content
//       .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
//       .join('');
//   }
//   return '';
// }

// export async function warmLLM() {
//   try {
//     await llm.invoke([{ role: 'user', content: 'hi' }]);
//     logger.info('[openai] Connection warmed');
//   } catch (err) {
//     logger.warn(`[openai] warm-up failed (harmless): ${err.message}`);
//   }
// }

// // ─────────────────────────────────────────────────────────────────────────────
// // RAHUL — unified agent node (token-streaming)
// // ─────────────────────────────────────────────────────────────────────────────

// export const rahulNode = async (state, runConfig) => {
//   const nodeStart = Date.now();
//   const threadId = runConfig?.configurable?.thread_id;
//   const turnId = runConfig?.configurable?.turnId ?? null;
//   const { userSummary, leadData } = state;


//   const messages = withoutUnheard(state.messages, threadId);
//   const lastMessage = messages[messages.length - 1];
//   const userText = lastMessage?.content ?? '';

//   const emitSentence = getSink(threadId);

//   const nowStr = new Date().toLocaleString('en-IN', {
//     timeZone: 'Asia/Kolkata',
//     dateStyle: 'full',
//     timeStyle: 'short',
//   });

//   logger.debug('[Rahul] Invoked', {
//     turn: messages.length,
//     name: leadData.name,
//     email: leadData.email,
//     date: leadData.date,
//     time: leadData.time,
//     input: typeof userText === 'string' ? userText.slice(0, 80) : '',
//   });

//   // ── 1. Build system prompt ────────────────────────────────────────────────
//   const replyLanguage = runConfig?.configurable?.replyLanguage;
//   const languageLine =
//     replyLanguage === 'hi' ? 'Hindi — simple spoken Hindi, in Devanagari script.'
//       : replyLanguage === 'en' ? 'English.'
//         : "not established yet — use the language of the caller's message.";

//   const contextBlock = `
// TODAY'S DATE & TIME (IST): ${nowStr}

// REPLY LANGUAGE (MANDATORY): ${languageLine}
// This is decided from what the caller has actually said. Do not switch because
// of a one-word reply, a name, an email, or a product name.

// CURRENT CALLER CONTEXT:
// - Name:    ${leadData.name || 'unknown — ask naturally when appropriate'}
// - Email:   ${leadData.email || 'unknown — ask when booking step 3 requires it'}
// - Date:    ${leadData.date || 'not mentioned yet'}
// - Time:    ${leadData.time || 'not mentioned yet'}
// - Memory:  ${userSummary || 'new caller — no prior history'}

// INSTRUCTIONS FOR DATA EXTRACTION:
// If the user provides new details (in English, Hindi, or Hinglish) in this turn, call the 'extract_lead_data' tool to log it. Convert Hindi terms like "kal" or "shaam 4 baje" to standard date/time format.
// CRITICAL: You must ALSO provide a normal spoken response, in the REPLY LANGUAGE, in your text content at the same time. Never reply with ONLY a tool call unless it's a calendar/email action.
//   `.trim();

//   const systemMessages = [
//     { role: 'system', content: RAHUL_PERSONA },
//     { role: 'system', content: contextBlock },
//   ];

//   // ── 2. Stream Rahul ───────────────────────────────────────────────────────
//   let freshData = {};
//   let finalMessage;

//   try {
//     const llmStart = Date.now();
//     let firstTokenAt = null;
//     let firstSentenceAt = null;

//     const chunker = createSentenceChunker();
//     let accumulated;         
//     let realToolSeen = false; // suppresses speech once a calendar/email call starts
//     let fillerSpoken = false; 


//     const input = [...systemMessages, ...messages];
//     const inputChars = input.reduce((n, m) => n + contentToText(m.content ?? '').length, 0);
//     logger.info(
//       `[LATENCY] llm.input = ${inputChars} chars, ${input.length} messages ` +
//       `(${messages.length} in history)`
//     );

//     const refusedRecently = recentAgentTexts(messages, 3).some((t) => REFUSAL_RE.test(t));
//     const callerInScope = IN_SCOPE_RE.test(String(userText));
//     let refusalSuppressed = false;
//     const shouldSuppress = (seg) =>
//       !refusalSuppressed && REFUSAL_RE.test(seg) && (refusedRecently || callerInScope);

//     const permit = assessBookingPermit(messages);
//     const BOOKING_TOOLS = new Set(['book_appointment', 'send_meeting_email']);
//     let bookingBlocked = null;

//     const stream = await rahulWithTools.stream(input);

//     for await (const chunk of stream) {
//       accumulated = accumulated === undefined ? chunk : accumulated.concat(chunk);

//       for (const tc of chunk.tool_call_chunks ?? []) {
//         if (tc.name && tc.name !== SILENT_TOOL) {
//           if (BOOKING_TOOLS.has(tc.name) && !permit.allowed && !bookingBlocked) {
//             bookingBlocked = permit.reason;
//           }
//           if (!realToolSeen && !bookingBlocked) {
//             logger.debug(`[Rahul] real tool call started (${tc.name}) — muting stream`);

//             const alreadySpoke = chunker.emittedCount > 0;
//             if (!alreadySpoke && !fillerSpoken) {
//               const filler = fillerFor(tc.name);
//               if (filler) {
//                 fillerSpoken = true;
//                 logger.info(`[Rahul] filler for ${tc.name}: "${filler}"`);
//                 emitSentence(filler);
//               }
//             }
//           }
//           realToolSeen = true;
//         }
//       }

//       const delta = contentToText(chunk.content);
//       if (!delta) continue;

//       if (firstTokenAt === null) {
//         firstTokenAt = Date.now();
//         logger.info(`[LATENCY] llm.firstToken = ${firstTokenAt - llmStart} ms`);
//       }

//       const segments = chunker.push(delta);
//       if (realToolSeen) continue; 

//       for (const seg of segments) {
//         if (shouldSuppress(seg)) {
//           refusalSuppressed = true;
//           logger.warn(
//             `[Rahul] refusal intercepted before speaking — ` +
//             (refusedRecently ? 'already refused recently' : 'caller asked about something in scope')
//           );
//         }
//         if (refusalSuppressed) continue;  
//         if (firstSentenceAt === null) {
//           firstSentenceAt = Date.now();
//           logger.info(`[LATENCY] llm.firstSentence = ${firstSentenceAt - llmStart} ms`);
//         }
//         emitSentence(seg);
//       }
//     }

//     const tail = chunker.flush();
//     if (tail && !realToolSeen && shouldSuppress(tail)) {
//       refusalSuppressed = true;
//       logger.warn('[Rahul] refusal intercepted before speaking');
//     }
//     if (tail && !realToolSeen && !refusalSuppressed) {
//       if (firstSentenceAt === null) {
//         logger.info(`[LATENCY] llm.firstSentence = ${Date.now() - llmStart} ms (tail only)`);
//       }
//       emitSentence(tail);
//     }

//     logger.info(`[LATENCY] llm.complete = ${Date.now() - llmStart} ms`);

//     if (!accumulated) throw new Error('empty stream from model');

//     let fullText = contentToText(accumulated.content);
//     const toolCalls = accumulated.tool_calls ?? [];

//     const regenerateSpoken = async (instruction) => {
//       const retryChunker = createSentenceChunker();
//       let retryText = '';
//       try {
//         const nudge = { role: 'system', content: instruction };
//         for await (const chunk of await llm.stream([...systemMessages, ...messages, nudge])) {
//           const delta = contentToText(chunk.content);
//           if (!delta) continue;
//           retryText += delta;
//           for (const seg of retryChunker.push(delta)) emitSentence(seg);
//         }
//         const tail = retryChunker.flush();
//         if (tail) emitSentence(tail);
//       } catch (err) {
//         logger.error(`[Rahul] regeneration failed: ${err.message}`);
//       }
//       return retryText;
//     };

//     if (refusalSuppressed) {
//       fullText = await regenerateSpoken(
//         'Do NOT say "I can only help with Xverse" or anything like it — ' +
//         (refusedRecently
//           ? 'you already said that and the caller heard it; repeating it sounds broken. '
//           : 'the caller is asking about something in scope. ') +
//         'Decide which case this is, then reply:\n' +
//         "- About you: you are Priya, Xverse's AI assistant — say so.\n" +
//         '- About Xverse, its products, or something you said earlier: answer it.\n' +
//         "- You couldn't make out what they said: say so and ask them to repeat.\n" +
//         '- Still clearly unrelated (weather, news, homework…): do NOT answer it. ' +
//         'In different words than before, gently ask what they would like to know about Xverse.\n' +
//         'One or two short sentences, in the REPLY LANGUAGE, ending with one question.',
//       );
//     }

//     const onlySilentTools = toolCalls.every((tc) => tc.name === SILENT_TOOL);
//     if (!fullText.trim() && onlySilentTools && !realToolSeen) {
//       logger.warn('[Rahul] model returned no spoken reply — regenerating as text');
//       fullText = await regenerateSpoken(
//         'Any details the caller just gave have already been saved. Now reply to ' +
//         'the caller OUT LOUD, in the REPLY LANGUAGE, in one short sentence — ' +
//         'acknowledge what they said and ask the next single question.',
//       );

//       if (!fullText.trim()) {
//         const hindi = /[\u0900-\u097F]/.test(String(userText));
//         fullText = hindi ? 'जी, बताइए।' : 'Sure, go ahead.';
//         emitSentence(fullText);
//       }
//     }

//     // ── 3. Intercept and strip the extraction tool ──────────────────────────
//     const extractionCall = toolCalls.find((tc) => tc.name === SILENT_TOOL);
//     let realToolCalls = toolCalls.filter((tc) => tc.name !== SILENT_TOOL);

//     const bookCall = realToolCalls.find((tc) => tc.name === 'book_appointment');
//     if (bookCall && !bookingBlocked && !sameEmail(bookCall.args?.email, permit.heardEmail)) {
//       bookingBlocked =
//         `the email being booked (${bookCall.args?.email}) is not the one the caller ` +
//         `confirmed (${permit.heardEmail})`;
//     }

//     if (bookingBlocked) {
//       logger.warn(`[Rahul] BOOKING BLOCKED — ${bookingBlocked}`);
//       realToolCalls = [];
//       fullText = await regenerateSpoken(
//         `Do NOT book the meeting yet: ${bookingBlocked}.\n` +
//         'If the caller was correcting or spelling something — for example their email — ' +
//         'read back what you now understand and ask if it is exactly right.\n' +
//         'Otherwise ask ONE final question that reads back the name, the email address, ' +
//         'the date and the time, ending with "बुक कर दूँ?" / "shall I book it?".\n' +
//         'Book only after a clear yes to that question. In the REPLY LANGUAGE.',
//       );
//     }

//     if (extractionCall) {
//       freshData = Object.fromEntries(
//         Object.entries(extractionCall.args ?? {}).filter(
//           ([, v]) => v !== null && v !== '' && v !== 'null'
//         )
//       );
//       logger.info('[Rahul] Extracted lead data via intercepted tool', freshData);
//     }

//     const booked = extractBookedFromMessages(messages);
//     if (booked) {
//       const changed = Object.entries(booked)
//         .filter(([k, v]) => k !== 'eventId' && freshData[k] && freshData[k] !== v);
//       if (changed.length) {
//         logger.warn(
//           '[Rahul] calendar overrides extracted lead data — ' +
//           changed.map(([k, v]) => `${k}: "${freshData[k]}" -> "${v}"`).join(', '),
//         );
//       }
//       freshData = { ...freshData, ...booked };
//       logger.info('[Rahul] lead data reconciled with the calendar', booked);
//     }

//     finalMessage = new AIMessage({
//       content: fullText,
//       tool_calls: realToolCalls,
//       additional_kwargs: { turnId },
//     });

//     logger.info('[Rahul] Response', {
//       hasToolCalls: realToolCalls.length > 0,
//       tools: realToolCalls.map((t) => t.name),
//       spokenSegments: chunker.emittedCount,
//       preview: fullText.slice(0, 80),
//     });

//     logger.info(`[LATENCY] Rahul Node Total = ${Date.now() - nodeStart} ms`);

//     return {
//       messages: [finalMessage],
//       leadData: freshData, 
//     };
//   } catch (err) {
//     logger.error('[Rahul] Error', { error: err.message });
//     const fallback = 'क्षमा करें, मैं समझ नहीं पाया। क्या आप दोबारा कह सकते हैं?';
    
//     emitSentence(fallback);
//     return {
//       messages: [new AIMessage({ content: fallback, additional_kwargs: { turnId } })],
//       leadData: freshData,
//     };
//   }
// };















// // src/agents/companyAgents.js
// import { ChatOpenAI } from '@langchain/openai';
// import { AIMessage } from '@langchain/core/messages';
// import { checkAvailabilityTool, bookAppointmentTool } from '../tools/calendar.js';
// import { sendMeetingEmailTool } from '../tools/email.js';
// import { RAHUL_PERSONA } from '../constants/prompts.js';
// import { logger } from '../utils/logger.js';
// import { config } from '../config/index.js';
// import { getSink } from './sentenceSink.js';
// import { fillerFor } from '../constants/fillers.js';
// import { withoutUnheard } from './unheardTurns.js';
// import { assessBookingPermit, sameEmail } from './bookingGuard.js';
// import { normalizeLeadData, normalizeEmail } from '../utils/leadNormalize.js';
// import { createSentenceChunker } from '../services/speechService.js';

// // ─────────────────────────────────────────────────────────────────────────────
// // Model setup
// // ─────────────────────────────────────────────────────────────────────────────

// const llm = new ChatOpenAI({
//   model: 'gpt-4o-mini',
//   temperature: 0.3,
//   maxTokens: 120,
//   timeout: Number(process.env.LLM_TIMEOUT_MS ?? 12_000),
//   maxRetries: 1,
//   modelKwargs: {
//     presence_penalty: 0,
//     frequency_penalty: 0,
//   },
// });

// const extractLeadDataTool = {
//   type: 'function',
//   function: {
//     name: 'extract_lead_data',
//     description: 'Call this silently to save caller\'s name, email, date, or time when stated in English, Hindi, or Hinglish (e.g. "kal 3 baje", "Mera naam Amit hai").',
//     parameters: {
//       type: 'object',
//       properties: {
//         name: { type: 'string' },
//         email: { type: 'string' },
//         date: { type: 'string', description: 'Format as YYYY-MM-DD if possible' },
//         time: { type: 'string', description: 'Format as HH:MM AM/PM' },
//       },
//     },
//   },
// };

// const rahulWithTools = llm.bindTools([
//   checkAvailabilityTool,
//   bookAppointmentTool,
//   sendMeetingEmailTool,
//   extractLeadDataTool,
// ]);

// const SILENT_TOOL = 'extract_lead_data';

// const REFUSAL_RE =
//   /सिर्फ़?\s*Xverse\s*के\s*बारे|only\s+(?:help|talk|assist)\s+(?:you\s+)?with\s+Xverse|can\s+only\s+(?:help|talk|assist)|मैं\s+सिर्फ़?\s+.*मदद\s+कर\s+सकती/i;

// const IN_SCOPE_RE =
//   /priya|प्रिया|xverse|एक्सवर्स|your\s+name|आपका\s+नाम|तुम्हारा\s+नाम|who\s+are\s+you|आप\s+कौन|are\s+you\s+(?:a\s+)?(?:bot|robot|human|ai)|company|कंपनी|कम्पनी|product|प्रोडक्ट|meeting|मीटिंग|book|बुक|price|कीमत|website|वेबसाइट|xmed|voxa|botique|consult|\bAI\b|\bmean\b|मतलब|matlab|more\s+about|और\s+बताओ|और\s+बताइए/i;

// function recentAgentTexts(messages, n) {
//   const out = [];
//   for (let i = messages.length - 1; i >= 0 && out.length < n; i--) {
//     const m = messages[i];
//     const type = m?._getType?.() ?? m?.getType?.() ?? m?.role;
//     if (type === 'ai' || type === 'assistant') out.push(contentToText(m.content ?? ''));
//   }
//   return out;
// }

// function extractBookedFromMessages(messages) {
//   for (let i = messages.length - 1; i >= 0; i--) {
//     const content = messages[i]?.content;
//     if (typeof content !== 'string') continue;
//     const m = /\[\[BOOKED:(\{.*?\})\]\]/s.exec(content);
//     if (!m) continue;
//     try {
//       const booked = JSON.parse(m[1]);
//       const out = {};
//       for (const key of ['date', 'time', 'eventId', 'name', 'email']) {
//         if (booked[key]) out[key] = booked[key];
//       }
//       return Object.keys(out).length ? out : null;
//     } catch {
//       return null;   
//     }
//   }
//   return null;
// }

// function contentToText(content) {
//   if (typeof content === 'string') return content;
//   if (Array.isArray(content)) {
//     return content
//       .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
//       .join('');
//   }
//   return '';
// }

// export async function warmLLM() {
//   try {
//     await llm.invoke([{ role: 'user', content: 'hi' }]);
//     logger.info('[openai] Connection warmed');
//   } catch (err) {
//     logger.warn(`[openai] warm-up failed (harmless): ${err.message}`);
//   }
// }
// // ─────────────────────────────────────────────────────────────────────────────
// // RAHUL — unified agent node (token-streaming)
// // ─────────────────────────────────────────────────────────────────────────────
// export const rahulNode = async (state, runConfig) => {
//   const nodeStart = Date.now();
//   const threadId = runConfig?.configurable?.thread_id;
//   const turnId = runConfig?.configurable?.turnId ?? null;
//   const { userSummary, leadData } = state;

//   const messages = withoutUnheard(state.messages, threadId);
//   const lastMessage = messages[messages.length - 1];
//   const userText = lastMessage?.content ?? '';
//   const emitSentence = getSink(threadId);
//   const nowStr = new Date().toLocaleString('en-IN', {
//     timeZone: 'Asia/Kolkata',
//     dateStyle: 'full',
//     timeStyle: 'short',
//   });

//   logger.debug('[Rahul] Invoked', {
//     turn: messages.length,
//     name: leadData.name,
//     email: leadData.email,
//     date: leadData.date,
//     time: leadData.time,
//     input: typeof userText === 'string' ? userText.slice(0, 80) : '',
//   });

//   const replyLanguage = runConfig?.configurable?.replyLanguage;
//   const languageLine =
//     replyLanguage === 'hi' ? 'Hindi — simple spoken Hindi, in Devanagari script.'
//       : 'English.';


//   const storedEmail = leadData.email ? normalizeEmail(leadData.email) : null;
//   const emailLine = storedEmail?.valid
//     ? storedEmail.email
//     : 'unknown — ask when the booking step requires it';

//   const contextBlock = `
// TODAY'S DATE & TIME (IST): ${nowStr}

// REPLY LANGUAGE (MANDATORY): ${languageLine}
// Already decided from what the caller has actually said — it is not yours to
// choose. Reply in this language even if the caller's last message was in the
// other one. Do NOT switch for a one-word reply, a greeting, a question like
// "how are you?", a name, an email, or a product name. The session switches it
// when the caller genuinely switches.

// CURRENT CALLER CONTEXT — the ONLY source of truth for these four values:
// - Name:    ${leadData.name || 'unknown — ask naturally when appropriate'}
// - Email:   ${emailLine}
// - Date:    ${leadData.date || 'not mentioned yet'}
// - Time:    ${leadData.time || 'not mentioned yet'}
// - Memory:  ${userSummary || 'new caller — no prior history'}

// When you read a detail back, or put it in the final booking question, copy it
// from the four lines above CHARACTER FOR CHARACTER. Never reproduce an earlier
// value from the conversation above — a value that was corrected still appears
// there, and reading it back makes the caller confirm the same thing twice.

// INSTRUCTIONS FOR DATA EXTRACTION:
// If the caller gives new details this turn (in English, Hindi or Hinglish), call
// 'extract_lead_data' to log it. Convert "kal" or "shaam 4 baje" to a standard
// date/time.
// ALWAYS IN ENGLISH / LATIN SCRIPT, whatever language the caller spoke: name as
// "Vibhav Vasti", email as "vibhav.vasti@gmail.com". Never put Devanagari in a
// name or an email — "विभव" must be logged and spoken back as "Vibhav", and a
// Devanagari email address is not a real address.
// CRITICAL: you must ALSO give a normal spoken response, in the REPLY LANGUAGE,
// in your text content at the same time. Never reply with ONLY a tool call unless
// it is a calendar/email action.
//   `.trim();

//   const systemMessages = [
//     { role: 'system', content: RAHUL_PERSONA },
//     { role: 'system', content: contextBlock },
//   ];

//   // ── 2. Stream Rahul ───────────────────────────────────────────────────────
//   let freshData = {};
//   let finalMessage;

//   try {
//     const llmStart = Date.now();
//     let firstTokenAt = null;
//     let firstSentenceAt = null;

//     const chunker = createSentenceChunker();
//     let accumulated;          
//     let realToolSeen = false; 
//     let fillerSpoken = false;

//     const input = [...systemMessages, ...messages];
//     const inputChars = input.reduce((n, m) => n + contentToText(m.content ?? '').length, 0);
//     logger.info(
//       `[LATENCY] llm.input = ${inputChars} chars, ${input.length} messages ` +
//       `(${messages.length} in history)`
//     );
//     const refusedRecently = recentAgentTexts(messages, 3).some((t) => REFUSAL_RE.test(t));
//     const callerInScope = IN_SCOPE_RE.test(String(userText));
//     let refusalSuppressed = false;
//     const shouldSuppress = (seg) =>
//       !refusalSuppressed && REFUSAL_RE.test(seg) && (refusedRecently || callerInScope);

//     const permit = assessBookingPermit(messages);
//     const BOOKING_TOOLS = new Set(['book_appointment', 'send_meeting_email']);
//     let bookingBlocked = null;

//     const stream = await rahulWithTools.stream(input);

//     for await (const chunk of stream) {
//       accumulated = accumulated === undefined ? chunk : accumulated.concat(chunk);
//       for (const tc of chunk.tool_call_chunks ?? []) {
//         if (tc.name && tc.name !== SILENT_TOOL) {
//           if (BOOKING_TOOLS.has(tc.name) && !permit.allowed && !bookingBlocked) {
//             bookingBlocked = permit.reason;
//           }
//           if (!realToolSeen && !bookingBlocked) {
//             logger.debug(`[Rahul] real tool call started (${tc.name}) — muting stream`);
//             const alreadySpoke = chunker.emittedCount > 0;
//             if (!alreadySpoke && !fillerSpoken) {
//               const filler = fillerFor(tc.name);
//               if (filler) {
//                 fillerSpoken = true;
//                 logger.info(`[Rahul] filler for ${tc.name}: "${filler}"`);
//                 emitSentence(filler);
//               }
//             }
//           }
//           realToolSeen = true;
//         }
//       }

//       const delta = contentToText(chunk.content);
//       if (!delta) continue;

//       if (firstTokenAt === null) {
//         firstTokenAt = Date.now();
//         logger.info(`[LATENCY] llm.firstToken = ${firstTokenAt - llmStart} ms`);
//       }

//       const segments = chunker.push(delta);
//       if (realToolSeen) continue; 

//       for (const seg of segments) {
//         if (shouldSuppress(seg)) {
//           refusalSuppressed = true;
//           logger.warn(
//             `[Rahul] refusal intercepted before speaking — ` +
//             (refusedRecently ? 'already refused recently' : 'caller asked about something in scope')
//           );
//         }
//         if (refusalSuppressed) continue;   // nothing after it is spoken either
//         if (firstSentenceAt === null) {
//           firstSentenceAt = Date.now();
//           logger.info(`[LATENCY] llm.firstSentence = ${firstSentenceAt - llmStart} ms`);
//         }
//         emitSentence(seg);
//       }
//     }

//     const tail = chunker.flush();
//     if (tail && !realToolSeen && shouldSuppress(tail)) {
//       refusalSuppressed = true;
//       logger.warn('[Rahul] refusal intercepted before speaking');
//     }
//     if (tail && !realToolSeen && !refusalSuppressed) {
//       if (firstSentenceAt === null) {
//         logger.info(`[LATENCY] llm.firstSentence = ${Date.now() - llmStart} ms (tail only)`);
//       }
//       emitSentence(tail);
//     }

//     logger.info(`[LATENCY] llm.complete = ${Date.now() - llmStart} ms`);

//     if (!accumulated) throw new Error('empty stream from model');

//     let fullText = contentToText(accumulated.content);
//     const toolCalls = accumulated.tool_calls ?? [];

//     const regenerateSpoken = async (instruction) => {
//       const retryChunker = createSentenceChunker();
//       let retryText = '';
//       try {
//         const nudge = { role: 'system', content: instruction };
//         for await (const chunk of await llm.stream([...systemMessages, ...messages, nudge])) {
//           const delta = contentToText(chunk.content);
//           if (!delta) continue;
//           retryText += delta;
//           for (const seg of retryChunker.push(delta)) emitSentence(seg);
//         }
//         const tail = retryChunker.flush();
//         if (tail) emitSentence(tail);
//       } catch (err) {
//         logger.error(`[Rahul] regeneration failed: ${err.message}`);
//       }
//       return retryText;
//     };

//     if (refusalSuppressed) {
//       fullText = await regenerateSpoken(
//         'Do NOT say "I can only help with Xverse" or anything like it — ' +
//         (refusedRecently
//           ? 'you already said that and the caller heard it; repeating it sounds broken. '
//           : 'the caller is asking about something in scope. ') +
//         'Decide which case this is, then reply:\n' +
//         "- About you: you are Priya, Xverse's AI assistant — say so.\n" +
//         '- About Xverse, its products, or something you said earlier: answer it.\n' +
//         "- You couldn't make out what they said: say so and ask them to repeat.\n" +
//         '- Still clearly unrelated (weather, news, homework…): do NOT answer it. ' +
//         'In different words than before, gently ask what they would like to know about Xverse.\n' +
//         'One or two short sentences, in the REPLY LANGUAGE, ending with one question.',
//       );
//     }

//     const onlySilentTools = toolCalls.every((tc) => tc.name === SILENT_TOOL);
//     if (!fullText.trim() && onlySilentTools && !realToolSeen) {
//       logger.warn('[Rahul] model returned no spoken reply — regenerating as text');
//       fullText = await regenerateSpoken(
//         'Any details the caller just gave have already been saved. Now reply to ' +
//         'the caller OUT LOUD, in the REPLY LANGUAGE, in one short sentence — ' +
//         'acknowledge what they said and ask the next single question.',
//       );
//       if (!fullText.trim()) {
//         const hindi = /[\u0900-\u097F]/.test(String(userText));
//         fullText = hindi ? 'जी, बताइए।' : 'Sure, go ahead.';
//         emitSentence(fullText);
//       }
//     }
//     // ── 3. Intercept and strip the extraction tool ──────────────────────────
//     const extractionCall = toolCalls.find((tc) => tc.name === SILENT_TOOL);
//     let realToolCalls = toolCalls.filter((tc) => tc.name !== SILENT_TOOL);
//     const bookCall = realToolCalls.find((tc) => tc.name === 'book_appointment');
//     if (bookCall && !bookingBlocked && !sameEmail(bookCall.args?.email, permit.heardEmail)) {
//       bookingBlocked =
//         `the email being booked (${bookCall.args?.email}) is not the one the caller ` +
//         `confirmed (${permit.heardEmail})`;
//     }

//     if (bookingBlocked) {
//       logger.warn(`[Rahul] BOOKING BLOCKED — ${bookingBlocked}`);
//       realToolCalls = [];
//       fullText = await regenerateSpoken(
//         `Do NOT book the meeting yet: ${bookingBlocked}.\n` +
//         'If the caller was correcting or spelling something — for example their email — ' +
//         'read back what you now understand and ask if it is exactly right.\n' +
//         'Otherwise ask ONE final question that reads back the name, the email address, ' +
//         'the date and the time, ending with "बुक कर दूँ?" / "shall I book it?".\n' +
//         'Take all four values from CURRENT CALLER CONTEXT, character for character. ' +
//         'Do NOT use an email, name, date or time from earlier in the conversation — ' +
//         'those may be the values that were already corrected.\n' +
//         'Book only after a clear yes to that question. In the REPLY LANGUAGE.',
//       );
//     }

//     if (extractionCall) {
//       const given = Object.fromEntries(
//         Object.entries(extractionCall.args ?? {}).filter(
//           ([, v]) => v !== null && v !== '' && v !== 'null'
//         )
//       );

//       const { data, dropped } = normalizeLeadData(given);
//       freshData = data;

//       logger.info('[Rahul] Extracted lead data via intercepted tool', freshData);
//       for (const d of dropped) {
    
//         logger.warn(`[Rahul] lead field rejected — ${d.field}="${d.raw}" (${d.reason})`);
//       }
//     }

//     const booked = extractBookedFromMessages(messages);
//     if (booked) {
//       const changed = Object.entries(booked)
//         .filter(([k, v]) => k !== 'eventId' && freshData[k] && freshData[k] !== v);
//       if (changed.length) {
//         logger.warn(
//           '[Rahul] calendar overrides extracted lead data — ' +
//           changed.map(([k, v]) => `${k}: "${freshData[k]}" -> "${v}"`).join(', '),
//         );
//       }
//       freshData = { ...freshData, ...booked };
//       logger.info('[Rahul] lead data reconciled with the calendar', booked);
//     }

//     finalMessage = new AIMessage({
//       content: fullText,
//       tool_calls: realToolCalls,
//       additional_kwargs: { turnId },
//     });

//     logger.info('[Rahul] Response', {
//       hasToolCalls: realToolCalls.length > 0,
//       tools: realToolCalls.map((t) => t.name),
//       spokenSegments: chunker.emittedCount,
//       preview: fullText.slice(0, 80),
//     });

//     logger.info(`[LATENCY] Rahul Node Total = ${Date.now() - nodeStart} ms`);

//     return {
//       messages: [finalMessage],
//       leadData: freshData, // LangGraph state reducer merges this automatically
//     };
//   } catch (err) {
//     logger.error('[Rahul] Error', { error: err.message });
//     const fallback = 'क्षमा करें, मैं समझ नहीं पाया। क्या आप दोबारा कह सकते हैं?';
//     // Speak the apology too — otherwise a mid-stream failure is dead air.
//     emitSentence(fallback);
//     return {
//       messages: [new AIMessage({ content: fallback, additional_kwargs: { turnId } })],
//       leadData: freshData,
//     };
//   }
// };

















// src/agents/companyAgents.js
import { ChatOpenAI } from '@langchain/openai';
import { AIMessage } from '@langchain/core/messages';
import { checkAvailabilityTool, bookAppointmentTool } from '../tools/calendar.js';
import { sendMeetingEmailTool } from '../tools/email.js';
import { RAHUL_PERSONA } from '../constants/prompts.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';
import { getSink } from './sentenceSink.js';
import { fillerFor } from '../constants/fillers.js';
import { withoutUnheard } from './unheardTurns.js';
import { assessBookingPermit, sameEmail } from './bookingGuard.js';
import { normalizeLeadData, normalizeEmail } from '../utils/leadNormalize.js';
import { createSentenceChunker } from '../services/speechService.js';

// ─────────────────────────────────────────────────────────────────────────────
// Model setup
// ─────────────────────────────────────────────────────────────────────────────

const llm = new ChatOpenAI({
  model: 'gpt-4o-mini',
  temperature: 0.3,
  // Raised from 80. Devanagari is token-hungry (a 20-word Hindi reply can run
  // 70-100 tokens) and 80 was silently truncating replies mid-word. With
  // streaming this costs nothing in time-to-first-audio, since we stop waiting
  // for the tail anyway.
  maxTokens: 120,
  // A request that hangs holds the caller in silence. Cap it, and retry once —
  // one retry recovers a dropped connection; more would just add dead air.
  timeout: Number(process.env.LLM_TIMEOUT_MS ?? 12_000),
  maxRetries: 1,
  modelKwargs: {
    presence_penalty: 0,
    frequency_penalty: 0,
  },
});

// 1. Define the extraction schema as a tool
const extractLeadDataTool = {
  type: 'function',
  function: {
    name: 'extract_lead_data',
    description: 'Call this silently to save caller\'s name, email, date, or time when stated in English, Hindi, or Hinglish (e.g. "kal 3 baje", "Mera naam Amit hai").',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        email: { type: 'string' },
        date: { type: 'string', description: 'Format as YYYY-MM-DD if possible' },
        time: { type: 'string', description: 'Format as HH:MM AM/PM' },
      },
    },
  },
};

// Rahul gets access to all real tools PLUS the dummy extraction tool
const rahulWithTools = llm.bindTools([
  checkAvailabilityTool,
  bookAppointmentTool,
  sendMeetingEmailTool,
  extractLeadDataTool,
]);

// extract_lead_data never reaches the ToolNode — it is a state-write dressed up
// as a tool call, and it is emitted *alongside* spoken text. Every other tool
// name means real work is about to happen.
const SILENT_TOOL = 'extract_lead_data';

// The "I can only help with Xverse" refusal, in either language.
const REFUSAL_RE =
  /सिर्फ़?\s*Xverse\s*के\s*बारे|only\s+(?:help|talk|assist)\s+(?:you\s+)?with\s+Xverse|can\s+only\s+(?:help|talk|assist)|मैं\s+सिर्फ़?\s+.*मदद\s+कर\s+सकती/i;

// Things a caller says that are plainly about Priya, Xverse or the call. A
// refusal in reply to any of these is wrong on its face. Taken from live calls
// where "I am asking about your name", "Yes Priya I want to know more about it"
// and "आप किसी company…" were all refused.
const IN_SCOPE_RE =
  /priya|प्रिया|xverse|एक्सवर्स|your\s+name|आपका\s+नाम|तुम्हारा\s+नाम|who\s+are\s+you|आप\s+कौन|are\s+you\s+(?:a\s+)?(?:bot|robot|human|ai)|company|कंपनी|कम्पनी|product|प्रोडक्ट|meeting|मीटिंग|book|बुक|price|कीमत|website|वेबसाइट|xmed|voxa|botique|consult|\bAI\b|\bmean\b|मतलब|matlab|more\s+about|और\s+बताओ|और\s+बताइए/i;

/** Text of the last `n` things the agent said, newest first. */
function recentAgentTexts(messages, n) {
  const out = [];
  for (let i = messages.length - 1; i >= 0 && out.length < n; i--) {
    const m = messages[i];
    const type = m?._getType?.() ?? m?.getType?.() ?? m?.role;
    if (type === 'ai' || type === 'assistant') out.push(contentToText(m.content ?? ''));
  }
  return out;
}

/**
 * Pull the authoritative booking out of a tool result.
 *
 * `book_appointment` embeds `[[BOOKED:{...}]]` naming the slot the calendar
 * actually holds. That outranks anything the model extracted: on a live call
 * the caller asked for 12:00, the slot was taken, the model booked 11:30 and
 * never revised its own extraction — so the CRM said 12:00 while the calendar
 * said 11:30.
 */
function extractBookedFromMessages(messages) {
  // Newest first: a re-booking later in the call supersedes an earlier one.
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]?.content;
    if (typeof content !== 'string') continue;
    const m = /\[\[BOOKED:(\{.*?\})\]\]/s.exec(content);
    if (!m) continue;
    try {
      const booked = JSON.parse(m[1]);
      const out = {};
      for (const key of ['date', 'time', 'eventId', 'name', 'email']) {
        if (booked[key]) out[key] = booked[key];
      }
      return Object.keys(out).length ? out : null;
    } catch {
      return null;   // malformed marker is not worth failing a call over
    }
  }
  return null;
}

/** Pulls plain text out of a content field that may be a string or block array. */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
      .join('');
  }
  return '';
}

/**
 * Open the HTTPS connection to OpenAI before the first caller arrives.
 *
 * Measured on a live call: first token took 2920ms, every later turn ran
 * 567-1268ms. That ~2s gap is DNS + TLS + first-request setup, and the caller
 * who happens to be first pays all of it. Sarvam TTS was already warmed at
 * boot; this closes the same hole on the model side.
 */
export async function warmLLM() {
  try {
    await llm.invoke([{ role: 'user', content: 'hi' }]);
    logger.info('[openai] Connection warmed');
  } catch (err) {
    // Never block startup on this — it is an optimisation, not a dependency.
    logger.warn(`[openai] warm-up failed (harmless): ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RAHUL — unified agent node (token-streaming)
// ─────────────────────────────────────────────────────────────────────────────

export const rahulNode = async (state, runConfig) => {
  const nodeStart = Date.now();
  const threadId = runConfig?.configurable?.thread_id;
  const turnId = runConfig?.configurable?.turnId ?? null;
  const { userSummary, leadData } = state;

  // The conversation as the caller HEARD it. A reply dropped because the
  // caller kept talking is still in the checkpoint, and without this the model
  // believes it said it — which is how an unspoken "बुक कर दूँ?" led to a
  // booking the caller never agreed to.
  const messages = withoutUnheard(state.messages, threadId);
  const lastMessage = messages[messages.length - 1];
  const userText = lastMessage?.content ?? '';

  // The session registers a sink under its callSid before invoking the graph.
  // When nothing is registered this is a no-op and the node behaves exactly
  // like the old blocking version.
  const emitSentence = getSink(threadId);

  // Get current date/time context in IST for relative Hindi terms ("kal", "parso")
  const nowStr = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'full',
    timeStyle: 'short',
  });

  logger.debug('[Rahul] Invoked', {
    turn: messages.length,
    name: leadData.name,
    email: leadData.email,
    date: leadData.date,
    time: leadData.time,
    input: typeof userText === 'string' ? userText.slice(0, 80) : '',
  });

  // ── 1. Build system prompt ────────────────────────────────────────────────
  // Order matters for prompt caching: the long static persona goes first so it
  // forms a stable prefix, and the per-turn context block follows it.
  // Default to English rather than "work it out yourself". Left to guess, the
  // model drifted to Hindi against an English caller — the persona and its
  // examples are mostly Devanagari, so that is the way it leans. English is
  // also what the unknown-caller greeting uses, so the call stays consistent.
  const replyLanguage = runConfig?.configurable?.replyLanguage;
  const languageLine =
    replyLanguage === 'hi' ? 'Hindi — simple spoken Hindi, in Devanagari script.'
      : 'English.';

  // Belt and braces: state is normalised on the way in, but a checkpoint
  // written before that change — or a profile loaded from the DB — can still
  // carry a Devanagari address. Never show the model one to read back.
  const storedEmail = leadData.email ? normalizeEmail(leadData.email) : null;
  const emailLine = storedEmail?.valid
    ? storedEmail.email
    : 'unknown — ask when the booking step requires it';

  const contextBlock = `
TODAY'S DATE & TIME (IST): ${nowStr}

REPLY LANGUAGE (MANDATORY): ${languageLine}
Already decided from what the caller has actually said — it is not yours to
choose. Reply in this language even if the caller's last message was in the
other one. Do NOT switch for a one-word reply, a greeting, a question like
"how are you?", a name, an email, or a product name. The session switches it
when the caller genuinely switches.

CURRENT CALLER CONTEXT — the ONLY source of truth for these four values:
- Name:    ${leadData.name || 'unknown — ask naturally when appropriate'}
- Email:   ${emailLine}
- Date:    ${leadData.date || 'not mentioned yet'}
- Time:    ${leadData.time || 'not mentioned yet'}
- Memory:  ${userSummary || 'new caller — no prior history'}

When you read a detail back, or put it in the final booking question, copy it
from the four lines above CHARACTER FOR CHARACTER. Never reproduce an earlier
value from the conversation above — a value that was corrected still appears
there, and reading it back makes the caller confirm the same thing twice.

INSTRUCTIONS FOR DATA EXTRACTION:
If the caller gives new details this turn (in English, Hindi or Hinglish), call
'extract_lead_data' to log it. Convert "kal" or "shaam 4 baje" to a standard
date/time.
ALWAYS IN ENGLISH / LATIN SCRIPT, whatever language the caller spoke: name as
"Vibhav Vasti", email as "vibhav.vasti@gmail.com". Never put Devanagari in a
name or an email — "विभव" must be logged and spoken back as "Vibhav", and a
Devanagari email address is not a real address.
CRITICAL: you must ALSO give a normal spoken response, in the REPLY LANGUAGE,
in your text content at the same time. Never reply with ONLY a tool call unless
it is a calendar/email action.
  `.trim();

  const systemMessages = [
    { role: 'system', content: RAHUL_PERSONA },
    { role: 'system', content: contextBlock },
  ];

  // ── 2. Stream Rahul ───────────────────────────────────────────────────────
  let freshData = {};
  let finalMessage;

  try {
    const llmStart = Date.now();
    let firstTokenAt = null;
    let firstSentenceAt = null;

    const chunker = createSentenceChunker();
    let accumulated;          // AIMessageChunk built up via .concat()
    let realToolSeen = false; // suppresses speech once a calendar/email call starts
    let fillerSpoken = false; // at most one filler per turn

    // Log what is being sent, so a slow first token can be attributed. TTFT
    // grows with input size, and two very different causes look identical in
    // the latency line alone: the prompt got bigger (fixable here), or the
    // provider got slower (not). This separates them.
    const input = [...systemMessages, ...messages];
    const inputChars = input.reduce((n, m) => n + contentToText(m.content ?? '').length, 0);
    logger.info(
      `[LATENCY] llm.input = ${inputChars} chars, ${input.length} messages ` +
      `(${messages.length} in history)`
    );

    // Refusal guard. A refusal is intercepted before it is spoken when it would
    // repeat one already given, or when the caller plainly asked about Priya,
    // Xverse or the call. Live calls showed the refusal becoming the default
    // answer to anything unclear — and then repeating turn after turn.
    const refusedRecently = recentAgentTexts(messages, 3).some((t) => REFUSAL_RE.test(t));
    const callerInScope = IN_SCOPE_RE.test(String(userText));
    let refusalSuppressed = false;
    const shouldSuppress = (seg) =>
      !refusalSuppressed && REFUSAL_RE.test(seg) && (refusedRecently || callerInScope);

    // Booking gate — decided BEFORE streaming, because the "बुक कर रही हूँ"
    // filler plays the moment a booking call appears and must not announce a
    // booking that is then refused.
    // The stored address is handed in so the gate can ask "did the caller hear
    // THIS address" by containment, instead of re-extracting one with a regex.
    // A regex whose trailing guard rejected a sentence-final "." refused five
    // consecutive confirmed bookings on a live call.
    const permit = assessBookingPermit(messages, storedEmail?.valid ? storedEmail.email : null);
    const BOOKING_TOOLS = new Set(['book_appointment', 'send_meeting_email']);
    let bookingBlocked = null;

    const stream = await rahulWithTools.stream(input);

    for await (const chunk of stream) {
      accumulated = accumulated === undefined ? chunk : accumulated.concat(chunk);

      // Tool names arrive in the *first* chunk of each tool call, well before
      // the arguments finish streaming. That is what makes this guard win the
      // race against the first completed sentence.
      for (const tc of chunk.tool_call_chunks ?? []) {
        if (tc.name && tc.name !== SILENT_TOOL) {
          if (BOOKING_TOOLS.has(tc.name) && !permit.allowed && !bookingBlocked) {
            bookingBlocked = permit.reason;
          }
          if (!realToolSeen && !bookingBlocked) {
            logger.debug(`[Rahul] real tool call started (${tc.name}) — muting stream`);

            // Say something while the tool runs. A calendar lookup plus a
            // booking took ~7s on a live call and the caller heard nothing.
            //
            // Only when nothing has been spoken yet this turn: if the model
            // already said "let me check", a filler on top would be the agent
            // announcing the same wait twice. Only once per turn, however many
            // tools follow.
            const alreadySpoke = chunker.emittedCount > 0;
            if (!alreadySpoke && !fillerSpoken) {
              // In the turn's reply language. These used to be Hindi only, so an
              // English call stayed English right up to the booking and then
              // said one Hindi sentence.
              const filler = fillerFor(tc.name, replyLanguage === 'hi' ? 'hi' : 'en');
              if (filler) {
                fillerSpoken = true;
                logger.info(`[Rahul] filler for ${tc.name}: "${filler}"`);
                emitSentence(filler);
              }
            }
          }
          realToolSeen = true;
        }
      }

      const delta = contentToText(chunk.content);
      if (!delta) continue;

      if (firstTokenAt === null) {
        firstTokenAt = Date.now();
        logger.info(`[LATENCY] llm.firstToken = ${firstTokenAt - llmStart} ms`);
      }

      const segments = chunker.push(delta);
      if (realToolSeen) continue; // buffer keeps draining, we just don't speak it

      for (const seg of segments) {
        if (shouldSuppress(seg)) {
          refusalSuppressed = true;
          logger.warn(
            `[Rahul] refusal intercepted before speaking — ` +
            (refusedRecently ? 'already refused recently' : 'caller asked about something in scope')
          );
        }
        if (refusalSuppressed) continue;   // nothing after it is spoken either
        if (firstSentenceAt === null) {
          firstSentenceAt = Date.now();
          logger.info(`[LATENCY] llm.firstSentence = ${firstSentenceAt - llmStart} ms`);
        }
        emitSentence(seg);
      }
    }

    const tail = chunker.flush();
    if (tail && !realToolSeen && shouldSuppress(tail)) {
      refusalSuppressed = true;
      logger.warn('[Rahul] refusal intercepted before speaking');
    }
    if (tail && !realToolSeen && !refusalSuppressed) {
      if (firstSentenceAt === null) {
        logger.info(`[LATENCY] llm.firstSentence = ${Date.now() - llmStart} ms (tail only)`);
      }
      emitSentence(tail);
    }

    logger.info(`[LATENCY] llm.complete = ${Date.now() - llmStart} ms`);

    if (!accumulated) throw new Error('empty stream from model');

    let fullText = contentToText(accumulated.content);
    const toolCalls = accumulated.tool_calls ?? [];

    // ── Regenerate as plain text ──────────────────────────────────────────
    // Tools are UNBOUND for this call, so the model can only answer in words.
    // Shared by the two recoveries below.
    const regenerateSpoken = async (instruction) => {
      const retryChunker = createSentenceChunker();
      let retryText = '';
      try {
        const nudge = { role: 'system', content: instruction };
        for await (const chunk of await llm.stream([...systemMessages, ...messages, nudge])) {
          const delta = contentToText(chunk.content);
          if (!delta) continue;
          retryText += delta;
          for (const seg of retryChunker.push(delta)) emitSentence(seg);
        }
        const tail = retryChunker.flush();
        if (tail) emitSentence(tail);
      } catch (err) {
        logger.error(`[Rahul] regeneration failed: ${err.message}`);
      }
      return retryText;
    };

    // ── Refusal recovery ────────────────────────────────────────────────────
    // The refusal was intercepted before it was spoken; answer properly instead.
    if (refusalSuppressed) {
      fullText = await regenerateSpoken(
        'Do NOT say "I can only help with Xverse" or anything like it — ' +
        (refusedRecently
          ? 'you already said that and the caller heard it; repeating it sounds broken. '
          : 'the caller is asking about something in scope. ') +
        'Decide which case this is, then reply:\n' +
        "- About you: you are Priya, Xverse's AI assistant — say so.\n" +
        '- About Xverse, its products, or something you said earlier: answer it.\n' +
        "- You couldn't make out what they said: say so and ask them to repeat.\n" +
        '- Still clearly unrelated (weather, news, homework…): do NOT answer it. ' +
        'In different words than before, gently ask what they would like to know about Xverse.\n' +
        'One or two short sentences, in the REPLY LANGUAGE, ending with one question.',
      );
    }

    // ── Silent-turn recovery ────────────────────────────────────────────────
    //
    // The model sometimes answers with ONLY extract_lead_data — the silent
    // tool that saves details — and no words at all. The caller then hears
    // nothing and waits; on a live call they sat in silence for 35 seconds
    // until they said "hello", and the model did it again on that turn too.
    //
    // The prompt forbids this and was ignored twice in a row, so a prompt
    // cannot be the guarantee.
    const onlySilentTools = toolCalls.every((tc) => tc.name === SILENT_TOOL);
    if (!fullText.trim() && onlySilentTools && !realToolSeen) {
      logger.warn('[Rahul] model returned no spoken reply — regenerating as text');
      fullText = await regenerateSpoken(
        'Any details the caller just gave have already been saved. Now reply to ' +
        'the caller OUT LOUD, in the REPLY LANGUAGE, in one short sentence — ' +
        'acknowledge what they said and ask the next single question.',
      );

      // Last resort. Silence is the one outcome that is never acceptable.
      if (!fullText.trim()) {
        // The decided reply language, not a guess from the caller's script: an
        // English caller with one Devanagari word in the transcript would
        // otherwise hear this single line in Hindi.
        fullText = replyLanguage === 'hi' ? 'जी, बताइए।' : 'Sure, go ahead.';
        emitSentence(fullText);
      }
    }

    // ── 3. Intercept and strip the extraction tool ──────────────────────────
    const extractionCall = toolCalls.find((tc) => tc.name === SILENT_TOOL);
    let realToolCalls = toolCalls.filter((tc) => tc.name !== SILENT_TOOL);

    // Second half of the gate: arguments are only complete now. The email being
    // booked must be exactly the one the caller heard read back and agreed to.
    const bookCall = realToolCalls.find((tc) => tc.name === 'book_appointment');
    if (bookCall && !bookingBlocked && !sameEmail(bookCall.args?.email, permit.heardEmail)) {
      bookingBlocked =
        `the email being booked (${bookCall.args?.email}) is not the one the caller ` +
        `confirmed (${permit.heardEmail})`;
    }

    if (bookingBlocked) {
      logger.warn(`[Rahul] BOOKING BLOCKED — ${bookingBlocked} | refusals=${permit.refusals}`);
      realToolCalls = [];

      // Escalate instead of repeating. The same final question went out five
      // times on a live call and the caller said yes to every one of them: the
      // gate refused, the regeneration prompt said "ask the final question",
      // and the model — correctly — asked the same final question. Nothing in
      // that circuit could ever break out of it.
      //
      // permit.refusals counts the clean yeses the caller has already given to
      // a final booking question. Past the first, asking a third time is not a
      // safety measure, it is a defect the caller has to sit through.
      if (permit.refusals >= 3) {
        logger.error(
          `[Rahul] BOOKING GATE LOOP — ${permit.refusals} confirmed yeses refused. ` +
          `heardEmail=${permit.heardEmail} stored=${storedEmail?.email} reason=${bookingBlocked}`,
        );
        fullText = await regenerateSpoken(
          'Do NOT book, and do NOT ask the booking question again — you have ' +
          'already asked it several times and the caller has already said yes. ' +
          'Something on our side is failing.\n' +
          'Apologise once, briefly, in ONE or TWO short sentences: say there is a ' +
          'technical problem completing the booking, that our team will confirm ' +
          'this meeting by email shortly, and thank them. Do not ask any question. ' +
          'In the REPLY LANGUAGE.',
        );
      } else if (permit.refusals === 2) {
        // Twice refused with the email in play: it is the email that is not
        // lining up, so confirm that on its own rather than re-reading the
        // whole summary the caller has already agreed to.
        fullText = await regenerateSpoken(
          `Do NOT book yet: ${bookingBlocked}.\n` +
          'The caller has already agreed to the summary, so do NOT repeat it. ' +
          'Ask about the EMAIL ONLY, in one short question, reading the address ' +
          'from CURRENT CALLER CONTEXT character for character — for example ' +
          '"just the email: is it exactly a-m-i-t at gmail dot com?". ' +
          'One question, in the REPLY LANGUAGE.',
        );
      } else {
        fullText = await regenerateSpoken(
          `Do NOT book the meeting yet: ${bookingBlocked}.\n` +
          'If the caller was correcting or spelling something — for example their email — ' +
          'read back what you now understand and ask if it is exactly right.\n' +
          'Otherwise ask ONE final question that reads back the name, the email address, ' +
          'the date and the time, ending with "बुक कर दूँ?" / "shall I book it?".\n' +
          'Take all four values from CURRENT CALLER CONTEXT, character for character. ' +
          'Do NOT use an email, name, date or time from earlier in the conversation — ' +
          'those may be the values that were already corrected.\n' +
          'Book only after a clear yes to that question. In the REPLY LANGUAGE.',
        );
      }
    }

    if (extractionCall) {
      const given = Object.fromEntries(
        Object.entries(extractionCall.args ?? {}).filter(
          ([, v]) => v !== null && v !== '' && v !== 'null'
        )
      );

      // Lead data is stored in English, always. The recogniser writes a Hindi
      // caller's name and email in Devanagari, and a Devanagari "email" is not
      // an email: it broke the booking guard's comparison, could not be spelled
      // back to the caller, and Calendar and SMTP would have rejected it.
      const { data, dropped } = normalizeLeadData(given);
      freshData = data;

      logger.info('[Rahul] Extracted lead data via intercepted tool', freshData);
      for (const d of dropped) {
        // Dropped rather than stored, so the next turn still shows the field as
        // unknown and the agent asks again — which is the right outcome.
        logger.warn(`[Rahul] lead field rejected — ${d.field}="${d.raw}" (${d.reason})`);
      }
    }

    // Applied AFTER the model's own extraction so it wins on conflict.
    const booked = extractBookedFromMessages(messages);
    if (booked) {
      const changed = Object.entries(booked)
        .filter(([k, v]) => k !== 'eventId' && freshData[k] && freshData[k] !== v);
      if (changed.length) {
        logger.warn(
          '[Rahul] calendar overrides extracted lead data — ' +
          changed.map(([k, v]) => `${k}: "${freshData[k]}" -> "${v}"`).join(', '),
        );
      }
      freshData = { ...freshData, ...booked };
      logger.info('[Rahul] lead data reconciled with the calendar', booked);
    }

    // Rebuild as a plain AIMessage so the graph's conditional edge and the
    // checkpointer both see a normal, fully-formed message rather than a chunk.
    finalMessage = new AIMessage({
      content: fullText,
      tool_calls: realToolCalls,
      // Lets this reply be left out of the model's view if it is never heard.
      additional_kwargs: { turnId },
    });

    logger.info('[Rahul] Response', {
      hasToolCalls: realToolCalls.length > 0,
      tools: realToolCalls.map((t) => t.name),
      spokenSegments: chunker.emittedCount,
      preview: fullText.slice(0, 80),
    });

    logger.info(`[LATENCY] Rahul Node Total = ${Date.now() - nodeStart} ms`);

    return {
      messages: [finalMessage],
      leadData: freshData, // LangGraph state reducer merges this automatically
    };
  } catch (err) {
    logger.error('[Rahul] Error', { error: err.message });
    // Was hardcoded Hindi, so a mid-stream failure on an English call produced
    // one Hindi sentence out of nowhere. Also masculine, for an agent called
    // Priya.
    const fallback = replyLanguage === 'hi'
      ? 'क्षमा करें, मैं समझ नहीं पाई। क्या आप दोबारा कह सकते हैं?'
      : 'Sorry, I did not catch that. Could you say it again?';
    // Speak the apology too — otherwise a mid-stream failure is dead air.
    emitSentence(fallback);
    return {
      messages: [new AIMessage({ content: fallback, additional_kwargs: { turnId } })],
      leadData: freshData,
    };
  }
};