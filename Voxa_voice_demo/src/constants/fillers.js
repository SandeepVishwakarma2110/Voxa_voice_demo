// src/constants/fillers.js
//
// What the agent says while a tool is running.
//
// A calendar lookup plus a booking took nearly seven seconds on a live call,
// and the caller heard silence for all of it — long enough to assume the line
// had dropped. These phrases cover that gap the way a person would.
//
// They are fixed strings, so they are synthesized once at startup and replayed
// from cache. A filler that took 300ms to synthesize would be covering latency
// with more latency.
//
// Both languages are here because these phrases used to be Hindi only. On an
// English call the agent would answer in English throughout and then, the moment
// it booked something, say "ठीक है, मैं आपके लिए मीटिंग बुक कर रही हूँ।" — the
// one Hindi sentence in an otherwise English call, and the one place the reply
// language was not being honoured.

/**
 * Tool name → what to say, per language. Keys must match the tool names bound
 * to the model. Override any of them with the matching env var.
 *
 * `||` not `??`: a blank env var (FILLER_X=) is almost always an accident, and
 * should fall back to the default rather than silently muting the agent during a
 * tool call. Use FILLERS_ENABLED=false to turn them all off.
 */
export const TOOL_FILLERS = {
  en: {
    check_availability: process.env.FILLER_CHECK_AVAILABILITY_EN
      || 'One second, let me check the calendar.',
    book_appointment: process.env.FILLER_BOOK_APPOINTMENT_EN
      || 'Alright, I am booking that meeting for you.',
    send_meeting_email: process.env.FILLER_SEND_EMAIL_EN
      || 'I am sending you the confirmation email.',
  },
  hi: {
    // Feminine forms — the agent is Priya.
    check_availability: process.env.FILLER_CHECK_AVAILABILITY
      || 'एक सेकंड, मैं कैलेंडर चेक कर रही हूँ।',
    book_appointment: process.env.FILLER_BOOK_APPOINTMENT
      || 'ठीक है, मैं आपके लिए मीटिंग बुक कर रही हूँ।',
    send_meeting_email: process.env.FILLER_SEND_EMAIL
      || 'मैं आपको कन्फर्मेशन ईमेल भेज रही हूँ।',
  },
};

/** Used when a tool has no phrase of its own. */
export const DEFAULT_FILLER = {
  en: process.env.FILLER_DEFAULT_EN || 'One second.',
  hi: process.env.FILLER_DEFAULT || 'एक सेकंड।',
};

/** Set FILLERS_ENABLED=false to go back to silence while tools run. */
export const FILLERS_ENABLED = process.env.FILLERS_ENABLED !== 'false';

/**
 * @param {string} toolName
 * @param {'en'|'hi'} [lang] The turn's reply language. Anything other than 'hi'
 *        is treated as English, which matches the call's default.
 */
export function fillerFor(toolName, lang = 'en') {
  if (!FILLERS_ENABLED) return null;
  const set = lang === 'hi' ? TOOL_FILLERS.hi : TOOL_FILLERS.en;
  const fallback = lang === 'hi' ? DEFAULT_FILLER.hi : DEFAULT_FILLER.en;
  return set[toolName] ?? fallback;
}

/**
 * Every phrase that should be pre-synthesized at boot — both languages, since
 * the call can switch to Hindi at any turn and a filler that has to be
 * synthesized on demand is latency covering latency.
 */
export function allFillerPhrases() {
  if (!FILLERS_ENABLED) return [];
  return [...new Set([
    ...Object.values(TOOL_FILLERS.en),
    ...Object.values(TOOL_FILLERS.hi),
    DEFAULT_FILLER.en,
    DEFAULT_FILLER.hi,
  ])].filter(Boolean);
}