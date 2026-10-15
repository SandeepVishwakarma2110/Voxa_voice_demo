// src/agents/bookingGuard.js
//
// A hard gate on book_appointment — the one action that cannot be taken back.
//
// On a live call the agent booked a meeting, and emailed a confirmation, to an
// address the caller was in the middle of correcting. Two things combined:
// the final "बुक कर दूँ?" had been written but never spoken, and the caller's
// correction contained "Yes." — the letter S, misheard while they spelled
// their email. The prompt already said to book only after a clear yes to the
// final summary. The model did it anyway, so the rule is enforced here.
//
// Booking is allowed only when BOTH hold:
//   1. the last thing the caller actually HEARD was the booking question, and
//      it contained the email address — so they heard what they agreed to;
//   2. their reply to it is a short, clear yes, with no correction in it.

import { extractAsciiEmail, hasDevanagari } from '../utils/leadNormalize.js';

const FINAL_CONFIRM_RE =
  /बुक\s*कर\s*(?:दूँ|दूं|दें|लूँ|लूं)|बुक\s*करूँ|बुक\s*करूं|shall\s+i\s+book|should\s+i\s+book|can\s+i\s+book|book\s+it\s*\?|confirm\s+(?:the|this)\s+booking/i;

// Was a plain /[A-Za-z0-9._%+-]+@…/, which is what made the agent ask the same
// confirmation question over and over on a live call.
//
// The recogniser had written the caller's email in Devanagari, so the agent read
// back "विभव.वस्ती54@gmail.com". That regex cannot see Devanagari, so it matched
// the ASCII tail — "54@gmail.com" — and the sameEmail() comparison against the
// stored address failed. Booking blocked, question re-asked, blocked again.
//
// extractAsciiEmail() refuses to match a fragment that has Devanagari or more
// text glued to its front, so a non-ASCII blob now yields NO heard email at all
// and the guard says so honestly instead of comparing two different strings.
// Lead data is normalised to ASCII upstream, so this is the second line of
// defence rather than the first.

const AFFIRM_RE =
  /(?:^|[\s,.!?।])(?:हाँ|हां|जी|yes|yeah|yep|yup|ok|okay|sure|बिल्कुल|बिलकुल|ठीक|सही|कर\s*दो|कर\s*दीजिए|कर\s*दें|confirm|correct|go\s+ahead|perfect)(?=$|[\s,.!?।])/i;

// Anything suggesting the caller is correcting, hesitating, or dictating.
const NOT_A_CLEAN_YES_RE =
  /नहीं|नही|\bमत\b|\bno\b|\bnot\b|\bdon'?t\b|wrong|गलत|repeat|दोबारा|फिर\s*से|change|बदल|wait|रुको|रुकिए|एक\s*मिनट|hold\s+on|actually|लेकिन|\bbut\b|@|\bdot\b|gmail|डॉट|जीमेल/i;

const MAX_YES_WORDS = 8;

function text(m) {
  const c = m?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  return '';
}

function kind(m) {
  return m?._getType?.() ?? m?.getType?.() ?? m?.role ?? m?.type;
}

/** Is this caller utterance a short, clean yes with no correction in it? */
function isCleanYes(reply) {
  const words = reply.split(/\s+/).filter(Boolean).length;
  return !NOT_A_CLEAN_YES_RE.test(reply)
    && words <= MAX_YES_WORDS
    && AFFIRM_RE.test(reply);
}

/**
 * How many times the caller has already given a clean yes to a final booking
 * question. If the booking had gone through, the conversation would have moved
 * on — so anything above 1 means this guard refused a confirmed booking that
 * many times, and asking again will not help.
 *
 * Derived from the message history rather than kept as state, so it survives
 * however the graph is checkpointed.
 */
export function countRefusedConfirmations(messages) {
  let n = 0;
  for (let i = 0; i < messages.length - 1; i++) {
    const k = kind(messages[i]);
    if (k !== 'ai' && k !== 'assistant') continue;
    if (!FINAL_CONFIRM_RE.test(text(messages[i]))) continue;
    // The next human turn after that question.
    for (let j = i + 1; j < messages.length; j++) {
      const kj = kind(messages[j]);
      if (kj === 'ai' || kj === 'assistant') break;
      if (kj === 'human' || kj === 'user') {
        if (isCleanYes(text(messages[j]).trim())) n++;
        break;
      }
    }
  }
  return n;
}

/**
 * @param {Array} messages  The conversation as the caller heard it (unheard
 *                          turns already removed).
 * @param {string|null} [expectedEmail]  The address held in state, already
 *        normalised to ASCII. When given, the check becomes "did the sentence
 *        the caller heard contain THIS address" — a substring test, which is
 *        the safety property stated directly and cannot be broken by
 *        punctuation. Regex extraction is only the fallback now, because a
 *        trailing "." in it looped a live call.
 * @returns {{ allowed: boolean, reason: string, heardEmail: string|null, reply: string, refusals: number }}
 */
export function assessBookingPermit(messages, expectedEmail = null) {
  // The caller's latest utterance, and the last thing we SAID before it.
  let humanAt = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (kind(messages[i]) === 'human' || kind(messages[i]) === 'user') { humanAt = i; break; }
  }
  const reply = humanAt >= 0 ? text(messages[humanAt]).trim() : '';

  let lastHeard = '';
  for (let i = humanAt - 1; i >= 0; i--) {
    const k = kind(messages[i]);
    if ((k === 'ai' || k === 'assistant') && text(messages[i]).trim()) { lastHeard = text(messages[i]); break; }
  }

  // Containment first: the question is "did the caller hear the address we are
  // about to book", and comparing against the stored value answers it exactly.
  const expected = expectedEmail ? String(expectedEmail).trim().toLowerCase() : '';
  let heardEmail = null;
  let spokeADifferentAddress = false;

  if (expected) {
    if (lastHeard.toLowerCase().includes(expected)) {
      heardEmail = expected;
    } else {
      // The agent read back an address that is not the one on file. That is the
      // "reverted to 60@gmail.com out of the history" failure, and it must not
      // book — the caller agreed to something state does not hold.
      heardEmail = extractAsciiEmail(lastHeard);
      spokeADifferentAddress = Boolean(heardEmail);
    }
  } else {
    heardEmail = extractAsciiEmail(lastHeard);
  }

  const refusals = countRefusedConfirmations(messages);

  if (!FINAL_CONFIRM_RE.test(lastHeard)) {
    return { allowed: false, reason: 'the final booking question has not been asked and heard yet', heardEmail, reply, refusals };
  }
  if (!heardEmail) {
    // Distinguish the two causes, because the fix differs: no address at all
    // means re-read the summary, whereas a Devanagari address means the stored
    // value is still unusable and has to be collected again in Latin letters.
    const devanagariAddress = /@/.test(lastHeard) && hasDevanagari(lastHeard.split('@')[0].slice(-20));
    return {
      allowed: false,
      reason: devanagariAddress
        ? 'the email read back was written in Devanagari, which is not a usable address — collect it again in English letters'
        : 'the final booking question did not include the email address',
      heardEmail,
      reply,
      refusals,
    };
  }
  if (spokeADifferentAddress) {
    return {
      allowed: false,
      reason: `the address read back (${heardEmail}) is not the one on file (${expected}) — ` +
        'confirm which one is right before booking',
      heardEmail,
      reply,
      refusals,
    };
  }
  if (!isCleanYes(reply)) {
    return { allowed: false, reason: `the caller's reply was not a clear yes: "${reply}"`, heardEmail, reply, refusals };
  }
  return { allowed: true, reason: 'confirmed', heardEmail, reply, refusals };
}

/** The email being booked must be exactly the one the caller heard and agreed to. */
export function sameEmail(a, b) {
  return Boolean(a && b) && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}