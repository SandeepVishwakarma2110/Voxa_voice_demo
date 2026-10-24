// src/utils/speakable.js
//
// Rewrites times and dates so the voice says them in the SAME language as the
// sentence around them.
//
// The model writes times the way they appear on a screen — "3:00 PM",
// "11:30 बजे", "9:00 AM, 10:00 AM" — even inside Hindi sentences. AM/PM are
// English tokens, so the voice switches language mid-sentence to read them:
// "कल three PM पर बुक हो गई है". Telling the model to write times differently
// works most of the time; rewriting them deterministically works every time.
//
// Applied to TTS input only. The transcript and logs keep the model's own
// text, where "3:00 PM" is the clearer thing to read.

const HI_NUM = [
  '', 'एक', 'दो', 'तीन', 'चार', 'पाँच', 'छह', 'सात', 'आठ', 'नौ', 'दस',
  'ग्यारह', 'बारह', 'तेरह', 'चौदह', 'पंद्रह', 'सोलह', 'सत्रह', 'अठारह', 'उन्नीस', 'बीस',
  'इक्कीस', 'बाईस', 'तेईस', 'चौबीस', 'पच्चीस', 'छब्बीस', 'सत्ताईस', 'अट्ठाईस', 'उनतीस', 'तीस',
  'इकतीस', 'बत्तीस', 'तैंतीस', 'चौंतीस', 'पैंतीस', 'छत्तीस', 'सैंतीस', 'अड़तीस', 'उनतालीस', 'चालीस',
  'इकतालीस', 'बयालीस', 'तैंतालीस', 'चवालीस', 'पैंतालीस', 'छियालीस', 'सैंतालीस', 'अड़तालीस', 'उनचास', 'पचास',
  'इक्यावन', 'बावन', 'तिरपन', 'चौवन', 'पचपन', 'छप्पन', 'सत्तावन', 'अट्ठावन', 'उनसठ',
];

const HI_MONTH = ['', 'जनवरी', 'फ़रवरी', 'मार्च', 'अप्रैल', 'मई', 'जून',
  'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर'];

const EN_MONTH = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * 'hi' | 'en' | null.
 *
 * null means the text has no words of its own — "9:00 AM, 10:00 AM." is only
 * times and punctuation. Deciding its language from its own characters is
 * wrong: the chunker splits replies into segments, so a list of slots can
 * arrive as a segment by itself, and reading it in English in the middle of a
 * Hindi reply is exactly the mixing this module exists to prevent. The caller
 * supplies the turn's language for that case.
 */
export function detectLanguage(text) {
  if (!text) return null;
  // Any Devanagari letter. The danda (।) is Devanagari too, which is why a
  // times-only segment ending in "।" happened to read correctly and one ending
  // in "." did not.
  if (/[\u0900-\u0963\u0966-\u097F]/.test(text)) return 'hi';
  const words = text
    .replace(/\b(?:AM|PM|am|pm)\b|\b[ap]\.m\./g, '')
    .replace(/[^A-Za-z]/g, '');
  return words.length ? 'en' : null;
}

// Words that say nothing about which language the caller is speaking. A lone
// "Yes." or "जी।" flipped the whole conversation when language followed the
// caller's LAST message.
const NEUTRAL_WORDS = new Set([
  'yes', 'no', 'ok', 'okay', 'correct', 'right', 'sure', 'hello', 'hi', 'hey',
  'thanks', 'thank', 'you', 'please', 'sorry', 'bye', 'haan', 'ji', 'nahi',
  // Hindi acknowledgements in Latin letters. English-speaking callers say
  // "theek hai" and "accha" the way they say "ok" — two of them in a row
  // counted as a Hindi sentence and flipped the whole call.
  // 'hai' is deliberately NOT here — it is the commonest Hindi verb, and
  // neutralising it would gut Hindi detection on short sentences. "theek hai"
  // therefore scores hi=1, which is weak: enough to open a call in Hindi,
  // never enough to flip one that is already in English.
  'theek', 'thik', 'teek', 'acha', 'accha', 'achha', 'achchha',
  'haa', 'han', 'hanji', 'haanji', 'jee', 'bas', 'arre', 'arrey', 'hmm', 'hm',
  'हाँ', 'हां', 'जी', 'नहीं', 'ठीक', 'हेलो', 'हैलो', 'हेल्लो', 'ओके', 'अच्छा',
  'धन्यवाद', 'थैंक', 'यू', 'सॉरी', 'बाय', 'क्या', 'हम्म', 'हूँ',
  // Dictating an email is not switching to English: "amit at gmail dot com"
  // from a Hindi caller must leave the conversation in Hindi.
  'at', 'dot', 'underscore', 'dash', 'hyphen', 'email', 'mail', 'id',
  'gmail', 'yahoo', 'hotmail', 'outlook', 'icloud', 'rediffmail', 'com', 'in', 'co', 'org', 'net',
  'एट', 'डॉट', 'जीमेल', 'कॉम', 'ईमेल',
  // English letter names as a Hindi recogniser writes them, when a caller
  // spells something out. Spelling is not speaking Hindi. ("के" is also a
  // common Hindi word, but a real Hindi sentence has plenty of others.)
  'ए', 'बी', 'सी', 'डी', 'ई', 'एफ', 'एच', 'आई', 'जे', 'के', 'एल', 'एम', 'एन',
  'ओ', 'पी', 'क्यू', 'आर', 'एस', 'टी', 'वी', 'डब्ल्यू', 'एक्स', 'वाई', 'जेड', 'ज़ेड',
]);

// Hindi written in Latin letters ("kaun sa time", "kal meeting book karni hai").
// Counted as Hindi, not English. Deliberately excludes words that are also
// common English ("main", "to", "the"), which would misfire on real English.
const ROMAN_HINDI = new Set([
  'kya', 'hai', 'hain', 'kaun', 'kaunsa', 'kaunsi', 'sa', 'si', 'mujhe', 'muje', 'mera', 'meri',
  'mere', 'aap', 'aapka', 'aapki', 'aapko', 'batao', 'bataiye', 'bataye', 'kal', 'parso',
  'nahin', 'karna', 'karni', 'karo', 'kar', 'chahiye', 'chahta', 'chahti', 'kab', 'kitne',
  'kitna', 'baje', 'subah', 'shaam', 'sham', 'raat', 'dopahar', 'theek', 'thik', 'acha',
  'accha', 'bhi', 'aur', 'ka', 'ki', 'ke', 'ko', 'mein', 'liye', 'wala', 'wali', 'hoga',
  'hogi', 'raha', 'rahi', 'tha', 'thi', 'kuch', 'abhi', 'kaise', 'kyun', 'kahan', 'bhai',
  // Common pronouns and verbs that were missing, so a short roman-Hindi
  // sentence like "yeh kya hai" is not read as English.
  'yeh', 'woh', 'hum', 'tum', 'kyon', 'kyu', 'sahi', 'galat', 'pata', 'samajh',
  'milega', 'karenge', 'chahte', 'bataye', 'dijiye', 'dena', 'lena', 'hona',
]);

// Content words in each language, with the words that say nothing about
// language already filtered out. Devanagari and roman Hindi are counted
// SEPARATELY because they are not equally trustworthy: the recognizer writes
// Devanagari when it actually heard Hindi, whereas roman-Hindi matching is a
// word-list heuristic that fires on fillers English speakers use too.
function countLanguageWords(text) {
  const words = String(text ?? '')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, ' ')
    .replace(/[0-9]+/g, ' ')
    .split(/[\s,.!?।॥;:()"'-]+/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w && !NEUTRAL_WORDS.has(w));

  let hiDev = 0, hiRoman = 0, en = 0;
  for (const w of words) {
    if (/[\u0900-\u097F]/.test(w)) hiDev++;
    else if (ROMAN_HINDI.has(w)) hiRoman++;
    else if (/^[a-z]+$/.test(w) && w.length > 1) en++;
  }
  return { hiDev, hiRoman, hi: hiDev + hiRoman, en };
}

/**
 * Which language a CALLER utterance is in, on its own merits.
 *
 *   'hi'  at least 2 Hindi words, and more Hindi than English
 *   'en'  at least 3 English words, and more English than Hindi
 *   null  anything shorter or mixed: "Yes.", "Correct.", "जी।", "Blue company.",
 *         "amit at gmail dot com"
 *
 * Returning null for short answers is the point: a name, a product name or a
 * dictated email must never be read as a language.
 *
 * This is a description, not the policy. nextReplyLanguage() below decides what
 * the agent actually speaks, and it is deliberately asymmetric.
 */
export function classifyCallerLanguage(text) {
  if (!text) return null;
  const { hi, en } = countLanguageWords(text);
  if (hi >= 2 && hi > en) return 'hi';
  if (en >= 3 && en > hi) return 'en';
  return null;
}

/**
 * The reply language for the next turn: English unless the caller speaks Hindi.
 *
 * The call opens in English — that is the greeting's language — and stays there
 * unless the caller actually says something in Hindi. Deliberately asymmetric,
 * because the two mistakes do not cost the same: answering an English caller in
 * Hindi is jarring, while staying in English one turn longer than necessary is
 * barely noticeable.
 *
 *   INTO Hindi   one Devanagari content word is enough. The recognizer writes
 *                Devanagari only when it heard Hindi, so that is real evidence.
 *                Roman Hindi needs two words, because "theek hai" and "accha"
 *                are what English-speaking callers say instead of "ok".
 *   OUT of Hindi needs a full English sentence (3+ words) and no Hindi at all,
 *                so "Blue company." or a dictated email cannot drag a Hindi call
 *                back into English.
 *
 * Acknowledgements never move it in either direction: "हाँ", "जी", "Yes", "ok"
 * are filtered out before anything is counted.
 *
 * @param {'hi'|'en'|null} current  The language in force. null or unknown = English.
 * @param {string} text             What the caller just said.
 * @returns {'hi'|'en'}
 */
export function nextReplyLanguage(current, text) {
  const { hiDev, hiRoman, hi, en } = countLanguageWords(text);

  if (hiDev >= 1) return 'hi';
  if (hiRoman >= 2 && hiRoman >= en) return 'hi';

  if (current === 'hi') return (en >= 3 && hi === 0) ? 'en' : 'hi';
  return 'en';
}

/** Kept for callers that only need a yes/no. */
export function isHindi(text) {
  return detectLanguage(text) === 'hi';
}

/** Time of day, in the words a Hindi speaker actually uses. */
function hiPeriod(h24) {
  if (h24 >= 4 && h24 < 12) return 'सुबह';
  if (h24 >= 12 && h24 < 16) return 'दोपहर';
  if (h24 >= 16 && h24 < 20) return 'शाम';
  return 'रात';
}

// How minutes past the hour are spoken.
//
//   literal     (default)  1:30 -> "एक बजकर तीस मिनट", 2:15 -> "दो बजकर पंद्रह मिनट"
//   colloquial             1:30 -> "डेढ़ बजे", 2:30 -> "ढाई बजे", 3:30 -> "साढ़े तीन बजे",
//                          2:15 -> "सवा दो बजे", 2:45 -> "पौने तीन बजे"
//
// Literal is the default because it cannot be misheard. "डेढ़" and "पौने"
// require the listener to do arithmetic, and a caller confirming a meeting
// slot should hear the exact number rather than an idiom for it.
const TIME_STYLE = (process.env.TIME_STYLE || 'literal').toLowerCase();

/** Whole hours are "तीन बजे" in either style; only minutes past differ. */
function hiClock(h12, min) {
  if (min === 0) return `${HI_NUM[h12]} बजे`;

  if (TIME_STYLE === 'colloquial') {
    const next = h12 === 12 ? 1 : h12 + 1;
    if (min === 30) {
      if (h12 === 1) return 'डेढ़ बजे';
      if (h12 === 2) return 'ढाई बजे';
      return `साढ़े ${HI_NUM[h12]} बजे`;
    }
    if (min === 15) return `सवा ${HI_NUM[h12]} बजे`;
    if (min === 45) return `पौने ${HI_NUM[next]} बजे`;
  }

  return `${HI_NUM[h12]} बजकर ${HI_NUM[min]} मिनट`;
}

function enClock(h12, min, ampm) {
  const suffix = ampm ? ` ${ampm}` : '';
  if (min === 0) return `${h12}${suffix}`;               // "3 PM", not "three zero zero"
  return `${h12}:${String(min).padStart(2, '0')}${suffix}`;
}

/** "3", "PM" -> 15. An hour with no AM/PM is taken as written. */
function to24(h, ampm) {
  if (!ampm) return h;
  const pm = ampm.toUpperCase() === 'PM';
  if (h === 12) return pm ? 12 : 0;
  return pm ? h + 12 : h;
}

// "3:00 PM", "3 PM", "15:30", "11:30 बजे" — optionally followed by बजे, which
// is swallowed so the rewrite does not produce "बजे बजे".
const TIME_RE =
  /\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM|am|pm|a\.m\.|p\.m\.)?(\s*बजे)?(?![\d:])/g;

// 2026-09-06
const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// Domain labels read as words; anything else is spelled.
const SPOKEN_DOMAIN_WORDS = new Set([
  'gmail', 'yahoo', 'hotmail', 'outlook', 'icloud', 'rediffmail', 'live', 'proton', 'protonmail',
  'com', 'in', 'co', 'org', 'net', 'edu', 'gov', 'io', 'ai',
]);

/**
 * "svish8703@gmail.com" -> "s v i s h 8 7 0 3 at gmail dot com".
 *
 * Read as a single word, an email is unrecognisable on a phone line — and a
 * confirmation the caller cannot follow is not a confirmation. An earlier call
 * saved "8703@gmail.com" for someone who had said "ciss8703". Spelling the
 * part before the @ character by character is what lets them catch that.
 */
function spellEmail(email) {
  const [local, domain] = email.split('@');
  const spellChars = (str) => [...str].map((ch) => (
    ch === '.' ? 'dot' : ch === '_' ? 'underscore' : ch === '-' ? 'dash' : ch === '+' ? 'plus' : ch
  )).join(' ');
  const domainSpoken = domain.split('.')
    .map((label) => (SPOKEN_DOMAIN_WORDS.has(label.toLowerCase()) ? label.toLowerCase() : spellChars(label)))
    .join(' dot ');
  return `${spellChars(local)} at ${domainSpoken}`;
}

const PERIOD_WORDS = ['सुबह', 'दोपहर', 'शाम', 'रात'];

/**
 * @param {string} text      One segment, exactly as the model produced it.
 * @param {'hi'|'en'} [fallback] Language to use when the segment has no words
 *        of its own. Pass the turn's language; defaults to Hindi.
 * @returns {string} The same segment with times and dates in one language.
 */
export function toSpeakable(text, fallback = 'hi') {
  if (!text) return text;
  const hindi = (detectLanguage(text) ?? fallback) === 'hi';

  // Emails first, so their digits are never mistaken for times or dates.
  let out = text.replace(EMAIL_RE, (m) => spellEmail(m));

  out = out.replace(ISO_DATE_RE, (m, y, mo, d) => {
    const month = Number(mo), day = Number(d);
    if (month < 1 || month > 12 || day < 1 || day > 31) return m;
    return hindi ? `${HI_NUM[day]} ${HI_MONTH[month]}` : `${EN_MONTH[month]} ${day}`;
  });

  // Repeated periods in a list read badly: "सुबह नौ बजे, सुबह दस बजे, सुबह
  // ग्यारह बजे". Say the period once, and again only when it changes.
  let lastPeriod = null;

  out = out.replace(TIME_RE, (m, hh, mm, ampm, baje, offset, whole) => {
    const h = Number(hh);
    const min = mm === undefined ? 0 : Number(mm);

    // Only rewrite things that are unmistakably clock times. A bare number is
    // left alone — "30 मिनट" and "2 लोग" are not times.
    const isTime = mm !== undefined || ampm || baje;
    if (!isTime) return m;
    if (h > 23 || min > 59) return m;

    const cleanAmpm = ampm ? ampm.replace(/\./g, '').toUpperCase() : null;
    const h24 = cleanAmpm ? to24(h, cleanAmpm) : h;
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;

    if (hindi) {
      // Without AM/PM and at 12 or under, the model means what it wrote
      // ("11:30 बजे"); do not invent a period it did not state.
      let period = (cleanAmpm || h > 12) ? hiPeriod(h24) : null;
      const say = hiClock(h12, min);

      // The model often writes the period itself — "सुबह 10:00 AM". Adding
      // another produced "सुबह सुबह दस बजे". If one sits just before the time,
      // it already did the job.
      const before = whole.slice(Math.max(0, offset - 8), offset).trim();
      if (PERIOD_WORDS.some((w) => before.endsWith(w))) {
        lastPeriod = period;
        period = null;
      }

      if (period && period !== lastPeriod) {
        lastPeriod = period;
        return `${period} ${say}`;
      }
      return say;
    }

    return enClock(h12, min, cleanAmpm ?? (h > 12 ? 'PM' : null));
  });

  return out;
}