// src/utils/callRecorder.js
//
// Records both sides of a call to a stereo WAV: caller on the left channel,
// agent on the right.
//
// Stereo rather than a mixdown on purpose. Two voices summed into one channel
// are hard to review when they overlap, and overlap is exactly what you want to
// inspect — barge-in, the agent talking over someone, a caller repeating
// themselves. Separate channels keep that legible.
//
// Alignment is the part that is easy to get wrong. Inbound audio arrives in
// real time, so its position is simply elapsed time. OUTBOUND audio does not:
// frames are written to the socket seconds before the caller hears them,
// because the provider buffers and plays them back at 1x. Appending outbound
// audio as it is sent would drift further out of sync with every turn. So the
// caller supplies the playback time for each agent segment and it is placed
// there.

import { mulawToPcm16 } from './audioUtils.js';
import { logger } from './logger.js';

const SAMPLE_RATE = 8000;
const BYTES_PER_SAMPLE = 2;          // PCM16
const BYTES_PER_MS = (SAMPLE_RATE * BYTES_PER_SAMPLE) / 1000;   // 16

/**
 * The WAV is built in memory and returned as a Buffer for storage in MongoDB —
 * no disk round-trip.
 *
 * @param {object}  opts
 * @param {string}  opts.callSid
 * @param {boolean} opts.enabled
 * @param {number}  opts.maxMs  Longest call whose audio is kept. Past this the
 *        recorder STOPS BUFFERING (so a long call cannot exhaust memory) and
 *        save() reports the audio as skipped rather than returning it.
 */
export function createCallRecorder({ callSid, enabled = true, maxMs = 5 * 60_000 }) {
  const startedAt = Date.now();
  const caller = [];   // [{ offsetMs, pcm }]
  const agent = [];
  let truncated = false;

  const push = (bucket, pcm, offsetMs) => {
    if (!enabled || !pcm?.length) return;
    if (offsetMs > maxMs) {
      // Stop buffering the moment the call is too long to keep. Carrying on
      // would hold minutes of audio in memory only to discard it at hangup.
      if (!truncated) {
        truncated = true;
        bucket.length = 0;
        (bucket === caller ? agent : caller).length = 0;
        logger.info(`[recorder:${callSid}] call passed the recording limit — audio will not be stored`);
      }
      return;
    }
    if (truncated) return;
    bucket.push({ offsetMs: Math.max(0, offsetMs), pcm });
  };

  /** Lay chunks onto a silent timeline at their offsets, leaving gaps silent. */
  const render = (bucket, totalMs) => {
    const track = Buffer.alloc(Math.ceil(totalMs * BYTES_PER_MS));
    for (const { offsetMs, pcm } of bucket) {
      // Byte offsets must land on a sample boundary or the channel picks up
      // a half-sample of noise and everything after it is shifted.
      let at = Math.round(offsetMs * BYTES_PER_MS);
      if (at % BYTES_PER_SAMPLE) at -= at % BYTES_PER_SAMPLE;
      if (at >= track.length) continue;
      pcm.copy(track, at, 0, Math.min(pcm.length, track.length - at));
    }
    return track;
  };

  return {
    enabled,

    /** Caller audio, already PCM16. Position is simply "now". */
    addCaller(pcm16) {
      push(caller, pcm16, Date.now() - startedAt);
    },

    /**
     * Drop agent audio scheduled to play at or after `atMs`.
     *
     * On barge-in the provider discards everything still buffered. Those frames
     * were already sent — and already recorded — but the caller never heard
     * them. Leaving them in makes the recording show the agent talking over the
     * caller, which is exactly the moment you want the recording to be honest.
     */
    truncateAgentAfter(atMs) {
      if (!enabled || truncated) return;
      const cut = atMs - startedAt;
      for (let i = agent.length - 1; i >= 0; i--) {
        const c = agent[i];
        const endMs = c.offsetMs + c.pcm.length / BYTES_PER_MS;
        if (c.offsetMs >= cut) {
          agent.splice(i, 1);                       // entirely unheard
        } else if (endMs > cut) {
          // Straddles the cut: keep only what played. Round down to a whole
          // sample so the channel does not pick up a half-sample of noise.
          let keep = Math.floor((cut - c.offsetMs) * BYTES_PER_MS);
          keep -= keep % BYTES_PER_SAMPLE;
          c.pcm = c.pcm.subarray(0, keep);
        }
      }
    },

    /**
     * Agent audio, as μ-law frames.
     * @param {Buffer[]} frames
     * @param {number} playbackAtMs Wall-clock the caller starts HEARING this,
     *        not when it was written to the socket.
     */
    addAgent(frames, playbackAtMs) {
      if (!enabled || !frames?.length) return;
      const mulaw = frames.length === 1 ? frames[0] : Buffer.concat(frames);
      push(agent, mulawToPcm16(mulaw), playbackAtMs - startedAt);
    },

    /**
     * Build the stereo WAV in memory.
     *
     * @returns {null
     *   | { skipped: true, reason: string, durationMs: number }
     *   | { buffer: Buffer, contentType: string, durationMs: number, bytes: number }}
     */
    save() {
      if (!enabled) return null;

      if (truncated) {
        const limit = maxMs >= 60_000 ? `${+(maxMs / 60_000).toFixed(1)} min`
          : maxMs >= 1000 ? `${+(maxMs / 1000).toFixed(1)}s`
          : `${maxMs}ms`;
        return {
          skipped: true,
          reason: `call longer than ${limit}`,
          durationMs: Date.now() - startedAt,
        };
      }

      if (!caller.length && !agent.length) return null;

      const end = (b) => b.reduce((max, c) => Math.max(max, c.offsetMs + c.pcm.length / BYTES_PER_MS), 0);
      const durationMs = Math.ceil(Math.max(end(caller), end(agent)));
      if (durationMs <= 0) return null;

      const left = render(caller, durationMs);
      const right = render(agent, durationMs);

      const samples = Math.floor(left.length / BYTES_PER_SAMPLE);
      const data = Buffer.alloc(samples * BYTES_PER_SAMPLE * 2);
      for (let i = 0; i < samples; i++) {
        data.writeInt16LE(left.readInt16LE(i * 2), i * 4);
        data.writeInt16LE(right.readInt16LE(i * 2), i * 4 + 2);
      }

      const header = Buffer.alloc(44);
      header.write('RIFF', 0);
      header.writeUInt32LE(36 + data.length, 4);
      header.write('WAVE', 8);
      header.write('fmt ', 12);
      header.writeUInt32LE(16, 16);
      header.writeUInt16LE(1, 20);                       // PCM
      header.writeUInt16LE(2, 22);                       // stereo
      header.writeUInt32LE(SAMPLE_RATE, 24);
      header.writeUInt32LE(SAMPLE_RATE * 2 * BYTES_PER_SAMPLE, 28);
      header.writeUInt16LE(2 * BYTES_PER_SAMPLE, 32);
      header.writeUInt16LE(16, 34);
      header.write('data', 36);
      header.writeUInt32LE(data.length, 40);

      const buffer = Buffer.concat([header, data]);
      return { buffer, contentType: 'audio/wav', durationMs, bytes: buffer.length };
    },
  };
}