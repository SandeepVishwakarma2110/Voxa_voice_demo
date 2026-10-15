
// import mongoose from 'mongoose';

// const turnSchema = new mongoose.Schema({
//   role: { type: String, enum: ['user', 'agent'], required: true },
//   agent: { type: String, default: null },       // 'rahul' | 'priya' | 'ansh'
//   text: { type: String, required: true },
//   timestamp: { type: Date, default: Date.now },
//   latencyMs: { type: Number, default: null },       // ms from utterance_end → first TTS byte
// });

// const logSchema = new mongoose.Schema(
//   {
//     callSid: { type: String, required: true, unique: true, index: true },
//     phoneNumber: { type: String, required: true, index: true },
//     startedAt: { type: Date, required: true },
//     endedAt: { type: Date, default: null },
//     durationMs: { type: Number, default: null },
//     turns: [turnSchema],

//     // Flattened conversation, ready to read or full-text search without
//     // reassembling `turns` in the client.
//     transcript: { type: String, default: null },

//     // Stereo WAV: caller left, agent right. The file lives on disk and only
//     // its path is stored — a 90s call is ~2.9MB, so a handful of calls would
//     // blow past MongoDB's 16MB document limit if the bytes went in here.
//     // Inside models/Log.js
//     recording: {
//       audioData: Buffer,        // Stores the raw binary bytes of the .wav file
//       contentType: { type: String, default: 'audio/wav' },
//       durationMs: Number,
//       bytes: Number
//     },

//     summary: { type: String, default: null },   
//   },
//   { timestamps: true }
// );

// export const Log = mongoose.model('Log', logSchema);



import mongoose from 'mongoose';

const turnSchema = new mongoose.Schema({
  role:      { type: String, enum: ['user', 'agent'], required: true },
  agent:     { type: String, default: null },       // 'rahul' | 'priya' | 'ansh'
  text:      { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  latencyMs: { type: Number, default: null },       // ms from utterance_end → first TTS byte
});

const logSchema = new mongoose.Schema(
  {
    callSid:     { type: String, required: true, unique: true, index: true },
    phoneNumber: { type: String, required: true, index: true },
    startedAt:   { type: Date, required: true },
    endedAt:     { type: Date, default: null },
    durationMs:  { type: Number, default: null },
    turns:       [turnSchema],

    // Flattened conversation, ready to read or full-text search without
    // reassembling `turns` in the client.
    transcript:  { type: String, default: null },

    // Stereo WAV: caller left, agent right. The file lives on disk and only
    // its path is stored — a 90s call is ~2.9MB, so a handful of calls would
    // blow past MongoDB's 16MB document limit if the bytes went in here.
   recording: {
      // select:false is the important part. Without it EVERY query that touches
      // Log drags the audio back — a list of 50 calls becomes ~70MB over the
      // wire. Ask for it explicitly when you actually want to play a recording:
      //   Log.findOne({ callSid }).select("+recording.audioData")
      audioData:  { type: Buffer, default: null, select: false },
      contentType:{ type: String, default: null },
      durationMs: { type: Number, default: null },
      bytes:      { type: Number, default: null },
      // Set when the call ran past CALL_RECORDING_MAX_MS and the audio was not
      // kept, so a missing recording is explained rather than looking broken.
      skippedReason: { type: String, default: null },
    },
 

    summary:     { type: String, default: null },   // optional post-call summary
  },
  { timestamps: true }
);

export const Log = mongoose.model('Log', logSchema);