// ── μ-law decode table (pre-computed for speed) ───────────────────────────────
const MULAW_DECODE_TABLE = new Int16Array(256);
(function buildDecodeTable() {
  for (let i = 0; i < 256; i++) {
    let ulaw = ~i & 0xFF;
    const sign     = ulaw & 0x80;
    const exponent = (ulaw >> 4) & 0x07;
    const mantissa = ulaw & 0x0F;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    MULAW_DECODE_TABLE[i] = sign ? -sample : sample;
  }
})();

/**
 * Encode a signed 16-bit PCM sample to a μ-law byte.
 * @param {number} sample  Signed int16 (-32768..32767)
 * @returns {number}       Unsigned 8-bit μ-law value
 */
export function linearToMulaw(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  return (~(sign | (exponent << 4) | mantissa)) & 0xFF;
}

/**
 * Decode a μ-law byte to signed 16-bit PCM.
 * @param {number} mulaw  Unsigned 8-bit μ-law value
 * @returns {number}      Signed int16
 */
export function mulawToLinear(mulaw) {
  return MULAW_DECODE_TABLE[mulaw & 0xFF];
}

/**
 * Convert a Buffer of μ-law bytes to a Buffer of little-endian PCM16 samples.
 * Output length = input.length * 2.
 */
export function mulawToPcm16(mulawBuf) {
  const out = Buffer.allocUnsafe(mulawBuf.length * 2);
  for (let i = 0; i < mulawBuf.length; i++) {
    out.writeInt16LE(MULAW_DECODE_TABLE[mulawBuf[i]], i * 2);
  }
  return out;
}

// ALIAS: Matches the exact function name required for our callSession.js fix
export const decodeMulawToPcm = mulawToPcm16;

/**
 * Convert a Buffer of little-endian PCM16 samples to a Buffer of μ-law bytes.
 * Output length = input.length / 2.
 */
export function pcm16ToMulaw(pcmBuf) {
  const samples = pcmBuf.length >> 1;
  const out = Buffer.allocUnsafe(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = linearToMulaw(pcmBuf.readInt16LE(i * 2));
  }
  return out;
}

/**
 * Decode a base64 μ-law payload from a Twilio Media message
 * and return a PCM16 Buffer ready for Sarvam AI's STT WebSocket.
 */
export function decodeMulawPayloadToPcm16(base64Payload) {
  const rawMulaw = Buffer.from(base64Payload, 'base64');
  return mulawToPcm16(rawMulaw);
}

/**
 * Encode a PCM16 Buffer to a base64 string suitable for
 * injecting back into Twilio via a "media" WebSocket message.
 */
export function encodePcm16ForTwilio(pcmBuf) {
  return pcm16ToMulaw(pcmBuf).toString('base64');
}

/**
 * Build a Twilio "media" WebSocket message payload.
 * @param {string} streamSid
 * @param {Buffer} pcm16Buf  8 kHz 16-bit mono PCM
 */
export function buildTwilioMediaMessage(streamSid, pcm16Buf) {
  return JSON.stringify({
    event: 'media',
    streamSid,
    media: { payload: encodePcm16ForTwilio(pcm16Buf) },
  });
}

/**
 * Build a Twilio "clear" WebSocket message to stop current audio playback (barge-in).
 */
export function buildTwilioClearMessage(streamSid) {
  return JSON.stringify({ event: 'clear', streamSid });
}

/**
 * Compute RMS of a PCM16 buffer (for simple energy-based silence detection).
 * Returns 0–32767.
 */
export function rms(pcmBuf) {
  if (pcmBuf.length < 2) return 0;
  const samples = pcmBuf.length >> 1;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const s = pcmBuf.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / samples);
}
// ─────────────────────────────────────────────────────────────────────────────
// WAV / RIFF helpers — used to keep ffmpeg off the hot TTS path
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a RIFF/WAVE buffer without spawning anything.
 * Walks the chunk list properly instead of assuming a 44-byte header, because
 * some encoders insert LIST/fact chunks before `data`.
 *
 * @returns {null | { audioFormat:number, channels:number, sampleRate:number,
 *                    bitsPerSample:number, data:Buffer }}
 *          null when the buffer is not RIFF/WAVE (caller should fall back).
 */
export function parseWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buf.toString('ascii', 8, 12) !== 'WAVE') return null;

  let offset = 12;
  let fmt = null;

  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === 'fmt ' && body + 16 <= buf.length) {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!fmt) return null;
      // Some streams write 0 or 0xFFFFFFFF as the data size; trust the buffer.
      const end =
        size > 0 && body + size <= buf.length ? body + size : buf.length;
      return { ...fmt, data: buf.subarray(body, end) };
    }

    // Chunks are word-aligned.
    offset = body + size + (size % 2);
  }

  return null;
}

/**
 * If the buffer is a RIFF container, return just the payload; otherwise return
 * it untouched. Sarvam returns μ-law either bare or WAV-wrapped depending on
 * the codec/version, so normalise before framing.
 */
export function stripRiffContainer(buf) {
  const parsed = parseWav(buf);
  return parsed ? parsed.data : buf;
}

/**
 * Resample + downmix PCM16 to mono.
 *
 * Downsampling averages every source sample in the output window (a box
 * filter) rather than picking the nearest one. Nearest-neighbour folds
 * everything above the new Nyquist back into the audible band as aliasing,
 * which on speech sounds like added grit. The box filter is not a great
 * low-pass, but it is enormously better than none and costs one add per
 * sample.
 *
 * This is a fallback path only — we normally ask the TTS provider for 8 kHz
 * directly, in which case nothing here runs.
 */
export function resamplePcm16(pcmBuf, fromRate, toRate, channels = 1) {
  const inSamples = Math.floor(pcmBuf.length / 2 / channels);

  const readMono = (i) => {
    if (channels === 1) return pcmBuf.readInt16LE(i * 2);
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += pcmBuf.readInt16LE((i * channels + c) * 2);
    }
    return sum / channels;
  };

  if (fromRate === toRate) {
    if (channels === 1) return pcmBuf;
    const out = Buffer.allocUnsafe(inSamples * 2);
    for (let i = 0; i < inSamples; i++) out.writeInt16LE(Math.round(readMono(i)), i * 2);
    return out;
  }

  const outSamples = Math.max(1, Math.floor((inSamples * toRate) / fromRate));
  const out = Buffer.allocUnsafe(outSamples * 2);
  const ratio = inSamples / outSamples;

  for (let i = 0; i < outSamples; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(inSamples, Math.max(start + 1, Math.floor((i + 1) * ratio)));

    let sum = 0;
    for (let s = start; s < end; s++) sum += readMono(s);

    let v = Math.round(sum / (end - start));
    if (v > 32767) v = 32767;
    else if (v < -32768) v = -32768;
    out.writeInt16LE(v, i * 2);
  }

  return out;
}

/**
 * Pure-JS WAV -> 8 kHz mono μ-law. Returns null when the input is not
 * uncompressed 16-bit PCM, so the caller can hand it to ffmpeg instead.
 */
export function wavToMulaw8k(buf) {
  const wav = parseWav(buf);
  if (!wav) return null;

  // 7 = WAVE_FORMAT_MULAW: already μ-law, only needs a rate check.
  if (wav.audioFormat === 7) {
    return wav.sampleRate === 8000 && wav.channels === 1 ? wav.data : null;
  }

  // 1 = WAVE_FORMAT_PCM.
  if (wav.audioFormat !== 1 || wav.bitsPerSample !== 16) return null;

  const mono8k = resamplePcm16(wav.data, wav.sampleRate, 8000, wav.channels);
  return pcm16ToMulaw(mono8k);
}