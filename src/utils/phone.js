// src/utils/phone.js
//
// Phone numbers arrive from three places that each write them differently:
// a spreadsheet a human types into ("+91 98765 43210", "098765-43210",
// "919876543210", or a number Sheets helpfully turned into 9.87654321e9), the
// Smartflo `start` frame, and our own Mongo profiles.
//
// They all have to agree, because the outbound dialer keys its pending-call
// registry by phone number — it is the only handle the stream gives us back.
// "+919876543210" and "9876543210" failing to match would mean every outbound
// call arrives looking like a stranger.
//
// Smartflo's own docs disagree with themselves on the accepted length: the
// validation error says "between 10 and 12 digits", the body-parameters section
// says 10 to 15, and the example is a bare 10-digit number. We send the bare
// national number by default and leave the shape configurable.

const INDIA_CC = '91';

/**
 * @param {string|number} raw
 * @returns {{
 *   valid: boolean, reason: string,
 *   digits: string,        // every digit, country code included
 *   national: string,      // 10 digits for India, no country code
 *   e164: string,          // +919876543210
 *   key: string,           // what the pending-call registry is keyed by
 * }}
 */
export function normalizePhone(raw) {
  const empty = { valid: false, digits: '', national: '', e164: '', key: '' };

  if (raw === null || raw === undefined || raw === '') {
    return { ...empty, reason: 'empty' };
  }

  // Sheets stores a numeric cell as a number, and a long one comes back in
  // exponential form. 9.87654321e9 would otherwise normalise to "9.87654321E9"
  // and then to the digits "9876543219" — a real number, belonging to someone
  // else. Refuse it and tell the user to format the column as text.
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw)) {
      return { ...empty, reason: 'came through as a non-integer number — format the Phone column as Plain text in Sheets' };
    }
    raw = String(raw);
  }

  const str = String(raw).trim();
  if (/e\+?\d+$/i.test(str)) {
    return { ...empty, reason: `looks like scientific notation ("${str}") — format the Phone column as Plain text in Sheets` };
  }

  let digits = str.replace(/\D/g, '');
  if (!digits) return { ...empty, reason: `no digits in "${str}"` };

  // Trunk prefix: 098765... as people write it locally.
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  // 00 91 98765...
  if (digits.startsWith('00')) digits = digits.slice(2);

  let national = digits;
  if (digits.length > 10 && digits.startsWith(INDIA_CC)) {
    national = digits.slice(INDIA_CC.length);
  }

  if (national.length !== 10) {
    return {
      ...empty,
      digits,
      reason: `${national.length} digits after normalising ("${str}") — an Indian mobile is 10`,
    };
  }
  if (!/^[6-9]/.test(national)) {
    return {
      ...empty,
      digits,
      national,
      reason: `starts with ${national[0]} — an Indian mobile starts 6, 7, 8 or 9`,
    };
  }

  return {
    valid: true,
    reason: 'ok',
    digits: national.length === digits.length ? INDIA_CC + national : digits,
    national,
    e164: `+${INDIA_CC}${national}`,
    key: national,
  };
}

/**
 * The single string both sides of the outbound flow agree on.
 *
 * Used as the pending-call registry key, so the dialer and the stream's `start`
 * frame resolve to the same entry however each of them spelled the number.
 * Returns '' when the number cannot be parsed, which callers must treat as
 * "no match" rather than as a key.
 */
export function phoneKey(raw) {
  return normalizePhone(raw).key;
}

/**
 * The shape to put in the Smartflo request body.
 *
 * @param {string|number} raw
 * @param {'national'|'cc'|'e164'} [format] SMARTFLO_NUMBER_FORMAT. 'national'
 *        (10 digits) matches the documented example and is the default; the
 *        others are there because the docs are inconsistent and a given account
 *        may want one of them.
 */
export function toDialFormat(raw, format = 'national') {
  const n = normalizePhone(raw);
  if (!n.valid) return null;
  if (format === 'e164') return n.e164;
  if (format === 'cc') return INDIA_CC + n.national;
  return n.national;
}