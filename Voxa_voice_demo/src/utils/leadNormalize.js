// src/utils/leadNormalize.js
//
// Lead data is stored and used in ENGLISH, always — whatever language the
// caller spoke it in.
//
// A Hindi caller still writes their own name and email in Latin letters, and
// the recogniser does not know that: asked to spell "Vibhav Vasti" it returns
// "विभव वस्ती". Left alone, that Devanagari flows straight into the booking:
//
//   • "विभव.वस्ती54@gmail.com" is not an email address. Every ASCII email
//     regex in the codebase matched only its tail, "54@gmail.com", so the
//     booking guard compared two different strings, refused the booking, and
//     the agent asked the same confirmation question over and over.
//   • toSpeakable() spells emails out character by character so the caller can
//     catch a mistake — but only ASCII ones. A Devanagari address was read as
//     one unintelligible blob, so the caller could not catch anything.
//   • Google Calendar and SMTP would have rejected it outright.
//
// So everything funnels through here on its way into state: names are
// transliterated to Latin, emails are reduced to ASCII and validated, and an
// email that cannot be made valid is DROPPED rather than stored — the agent
// then asks again, which is the correct outcome.

// ─────────────────────────────────────────────
// Devanagari → Latin
// ─────────────────────────────────────────────

// A consonant carries an inherent "a" unless a vowel sign, a virama or the end
// of the word says otherwise. This sentinel marks those inherent vowels so the
// word-final one can be dropped at the end — "विभव" is Vibhav, not Vibhava.
const INHERENT = '\u0001';

const VIRAMA = '्';       // ्  suppresses the inherent vowel
const NUKTA = '़';        // ़  shifts क to q, ज to z, …
const ANUSVARA = 'ं';     // ं  nasal
const CHANDRABINDU = 'ँ'; // ँ  nasal
const VISARGA = 'ः';      // ः

const CONSONANTS = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'ng',
  'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'ny',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
  'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
  'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v',
  'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h', 'ळ': 'l',
  // Precomposed nukta forms, in case they arrive already combined.
  'क़': 'q', 'ख़': 'kh', 'ग़': 'g', 'ज़': 'z', 'ड़': 'r', 'ढ़': 'rh', 'फ़': 'f', 'य़': 'y',
};

// Applied when a bare consonant is followed by a separate nukta character.
const NUKTA_SHIFT = { 'क': 'q', 'ज': 'z', 'ड': 'r', 'ढ': 'rh', 'फ': 'f', 'ग': 'g', 'ख': 'kh' };

// Short vowels throughout. "वस्ती" becomes Vasti rather than Vastee, which is
// how Indian names are actually written in Latin script.
const VOWELS = {
  'अ': 'a', 'आ': 'a', 'इ': 'i', 'ई': 'i', 'उ': 'u', 'ऊ': 'u', 'ऋ': 'ri',
  'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऑ': 'o', 'ऍ': 'e', 'ऎ': 'e', 'ऒ': 'o',
};

const MATRAS = {
  'ा': 'a',  // ा
  'ि': 'i',  // ि
  'ी': 'i',  // ी
  'ु': 'u',  // ु
  'ू': 'u',  // ू
  'ृ': 'ri', // ृ
  'े': 'e',  // े
  'ै': 'ai', // ै
  'ो': 'o',  // ो
  'ौ': 'au', // ौ
  'ॉ': 'o',  // ॉ
  'ॅ': 'e',  // ॅ
  'ॆ': 'e',  // ॆ
  'ॊ': 'o',  // ॊ
};

const DIGITS = {
  '०': '0', '१': '1', '२': '2', '३': '3', '४': '4',
  '५': '5', '६': '6', '७': '7', '८': '8', '९': '9',
};

/**
 * "विभव" -> "vibhav", "वस्ती" -> "vasti", "अमित कुमार" -> "amit kumar".
 *
 * ASCII passes through untouched, so a mixed string like "विभव Kumar" works.
 */
export function romanize(input) {
  if (!input) return '';
  const s = String(input);
  let out = '';

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (CONSONANTS[ch]) {
      let base = CONSONANTS[ch];
      if (s[i + 1] === NUKTA) {
        base = NUKTA_SHIFT[ch] ?? base;
        i++;
      }
      out += base;

      const next = s[i + 1];
      if (next === VIRAMA) {
        i++;                      // consonant cluster — no vowel at all
      } else if (MATRAS[next]) {
        out += MATRAS[next];
        i++;
      } else {
        out += INHERENT;          // provisional "a", may be dropped word-finally
      }
      continue;
    }

    if (VOWELS[ch]) { out += VOWELS[ch]; continue; }
    if (MATRAS[ch]) { out += MATRAS[ch]; continue; }          // stray matra
    if (DIGITS[ch]) { out += DIGITS[ch]; continue; }
    if (ch === ANUSVARA || ch === CHANDRABINDU) { out += 'n'; continue; }
    if (ch === VISARGA) { out += 'h'; continue; }
    if (ch === VIRAMA || ch === NUKTA) continue;
    if (ch === '।' || ch === '॥') { out += '.'; continue; }

    out += ch;                     // ASCII and punctuation
  }

  // Drop the inherent vowel at the end of a word; keep the rest.
  return out
    .replace(new RegExp(`${INHERENT}(?=$|[^A-Za-z0-9${INHERENT}])`, 'g'), '')
    .split(INHERENT).join('a');
}

/** True if the string contains any Devanagari at all. */
export function hasDevanagari(text) {
  return /[ऀ-ॿ]/.test(String(text ?? ''));
}

// ─────────────────────────────────────────────
// Names
// ─────────────────────────────────────────────

/**
 * Stored in Latin script, Title Case, with the recogniser's punctuation gone.
 * Returns '' when nothing usable is left, which the caller treats as "not
 * captured" rather than storing a blank.
 */
export function normalizeName(raw) {
  if (!raw) return '';
  const latin = romanize(raw)
    .replace(/[^A-Za-z\s'.-]/g, ' ')     // digits in a name are mis-recognition
    .replace(/\s+/g, ' ')
    .trim();
  if (!latin) return '';

  return latin
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// ─────────────────────────────────────────────
// Emails
// ─────────────────────────────────────────────

// Spoken separators, in both scripts. The caller dictates "amit at gmail dot
// com" and the recogniser writes exactly that; a Hindi caller may produce "एट"
// and "डॉट". "at the rate" is the common Indian English form.
const SPOKEN = [
  [/\b(?:at\s+the\s+rate(?:\s+of)?|at\s+rate)\b/gi, '@'],
  [/\bat\s*sign\b/gi, '@'],
  [/\bdot\b/gi, '.'],
  [/\bunderscore\b/gi, '_'],
  [/\b(?:dash|hyphen|minus)\b/gi, '-'],
  [/\bplus\b/gi, '+'],
  [/\bat\b/gi, '@'],                     // after the multi-word forms above
];

// `\b` is ASCII-only in JavaScript, so `\bएट\b` never matches anything —
// Devanagari letters are not word characters as far as the regex engine is
// concerned. These use explicit script lookarounds instead, longest form
// first so "एट द रेट" wins over a bare "एट".
const DEV = 'ऀ-ॿ';
const dev = (body) => new RegExp(`(?<![${DEV}])(?:${body})(?![${DEV}])`, 'g');

const HINDI_SPOKEN = [
  [dev('एट\\s*(?:द\\s*)?रेट'), '@'],
  [dev('एट'), '@'],
  [dev('डॉट|डाट|डाॅट'), '.'],
  [dev('अंडरस्कोर|अन्डरस्कोर'), '_'],
  [dev('डैश|हाइफ़न|हाइफन'), '-'],
  [dev('जीमेल'), 'gmail'],
  [dev('याहू'), 'yahoo'],
  [dev('कॉम|काॅम'), 'com'],
];

const VALID_EMAIL_RE = /^[a-z0-9](?:[a-z0-9._%+-]*[a-z0-9])?@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;

/**
 * Reduce whatever was heard to a usable ASCII address.
 *
 * @returns {{ email: string, valid: boolean, reason: string }}
 *          `email` is the best ASCII form reached, for logging. Store it only
 *          when `valid` is true.
 */
export function normalizeEmail(raw) {
  if (!raw) return { email: '', valid: false, reason: 'nothing given' };

  let s = String(raw).trim();

  // Hindi spoken forms first, while the Devanagari is still intact.
  for (const [re, to] of HINDI_SPOKEN) s = s.replace(re, to);

  s = romanize(s);
  for (const [re, to] of SPOKEN) s = s.replace(re, to);

  s = s
    .replace(/\s+/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._%+@-]/g, '')     // anything still non-ASCII goes
    .replace(/\.{2,}/g, '.')
    .replace(/@{2,}/g, '@');

  const at = s.indexOf('@');
  if (at === -1) return { email: s, valid: false, reason: 'no @ in the address' };
  if (s.indexOf('@', at + 1) !== -1) return { email: s, valid: false, reason: 'more than one @' };

  let [local, domain] = s.split('@');
  local = local.replace(/^[._%+-]+/, '').replace(/[._%+-]+$/, '');
  domain = domain.replace(/^[.-]+/, '').replace(/[.-]+$/, '');
  const email = `${local}@${domain}`;

  if (!local) return { email, valid: false, reason: 'nothing before the @' };

  // The one that bit us: "विभव.वस्ती54@gmail.com" survived as "54@gmail.com"
  // and "...60. at the rate gmail dot com" as "60@gmail.com". A local part
  // with no letters in it is a transcription failure far more often than it is
  // somebody's real address, and booking to the wrong address is the single
  // worst thing this agent can do.
  if (!/[a-z]/.test(local)) {
    return { email, valid: false, reason: 'only digits before the @ — the name was not transcribed' };
  }
  if (!domain.includes('.')) return { email, valid: false, reason: 'domain has no dot' };
  if (!VALID_EMAIL_RE.test(email)) return { email, valid: false, reason: 'not a valid address' };

  return { email, valid: true, reason: 'ok' };
}

/**
 * Pulls a genuinely ASCII address out of a sentence; ignores Devanagari blobs.
 *
 * The TRAILING guard used to be (?![A-Za-z0-9.\-<devanagari>]), which put "." in
 * the forbidden set. That made an address at the END OF A SENTENCE fail to
 * match at all:
 *
 *   "... and your email is sviish8703@gmail.com. Should I book it?"  ->  null
 *
 * which is precisely how the agent reads a booking summary back. The booking
 * guard then reported "the final booking question did not include the email
 * address", refused the booking, and asked the same question again — forever.
 * The caller said yes five times. Every test I had written put a COMMA after
 * the address, so the suite never saw it.
 *
 * What the guard is actually for is catching a TRUNCATED match — "54@gmail.com"
 * pulled out of "विभव.वस्ती54@gmail.com", or a domain cut short at
 * "foo@gmail.co" out of "foo@gmail.co.uk". So: letters, digits and Devanagari
 * are forbidden outright, while "." and "-" are forbidden only when another
 * alphanumeric follows them. Sentence punctuation is then fine.
 *
 * The Devanagari range is \u0900-\u0963 plus \u0966-\u097F, not the whole block:
 * U+0964 and U+0965 are the danda and double danda, which are PUNCTUATION — the
 * Hindi full stop. Forbidding the whole block rejected "...amit@gmail.com।",
 * the natural end of a Hindi read-back. U+0966-096F are the Devanagari digits
 * and stay forbidden, because a digit glued on does mean a truncated match.
 * detectLanguage() in speakable.js splits the range the same way, for the same
 * reason.
 */
export function extractAsciiEmail(text) {
  if (!text) return null;
  // The leading guard is what stops "विभव.वस्ती54@gmail.com" matching as
  // "54@gmail.com" — the character before the local part must not be a letter,
  // a digit or Devanagari.
  const m = String(text).match(
    /(?:^|[^A-Za-z0-9._%+\-ऀ-ॣ०-ॿ])([A-Za-z0-9](?:[A-Za-z0-9._%+-]*[A-Za-z0-9])?@[A-Za-z0-9.-]+\.[A-Za-z]{2,})(?![A-Za-z0-9ऀ-ॣ०-ॿ])(?![.-][A-Za-z0-9])/,
  );
  return m ? m[1] : null;
}

// ─────────────────────────────────────────────
// The whole record
// ─────────────────────────────────────────────

/**
 * Normalise a lead-data patch on its way into state.
 *
 * name  -> Latin, Title Case
 * email -> ASCII and validated, or omitted entirely
 * date  -> kept (the model already emits YYYY-MM-DD)
 * time  -> kept (the model already emits "10:00 AM"), Devanagari digits fixed
 *
 * @returns {{ data: object, dropped: Array<{field: string, raw: string, reason: string}> }}
 */
export function normalizeLeadData(patch = {}) {
  const data = { ...patch };
  const dropped = [];

  if (data.name != null && data.name !== '') {
    const name = normalizeName(data.name);
    if (name) data.name = name;
    else { dropped.push({ field: 'name', raw: String(data.name), reason: 'nothing usable left' }); delete data.name; }
  }

  if (data.email != null && data.email !== '') {
    const { email, valid, reason } = normalizeEmail(data.email);
    if (valid) data.email = email;
    else { dropped.push({ field: 'email', raw: String(data.email), reason }); delete data.email; }
  }

  // Devanagari numerals occasionally come back in a time or date.
  for (const k of ['date', 'time']) {
    if (data[k] != null && data[k] !== '' && hasDevanagari(data[k])) {
      data[k] = romanize(data[k]).replace(/\s+/g, ' ').trim();
    }
  }

  return { data, dropped };
}