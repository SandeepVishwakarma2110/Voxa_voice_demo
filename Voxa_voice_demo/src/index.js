// //src/index.js
// import 'dotenv/config';
// import http from 'http';
// import { WebSocketServer } from 'ws';
// import { app } from './app.js';
// import { config } from './config/index.js';
// import { connectDB } from './utils/db.js';
// import { startCleanupCron } from './utils/cleanup.js';
// import { handleMediaStream } from './websocket/mediaStreamHandler.js';
// import { logger } from './utils/logger.js';
// import { sessionManager } from './utils/sessionManager.js';
// import { warmTTS, prewarmPhrases } from './services/speechService.js';
// import { warmLLM } from './agents/companyAgents.js';
// import { allFillerPhrases } from './constants/fillers.js';

// async function main() {
//   // ── Database ──────────────────────────────────────────────────────────────
//   console.time('startup');
//   await connectDB();

//   // Warm both upstreams in parallel so the first caller does not pay for
//   // either handshake.
//   await Promise.allSettled([warmTTS(), warmLLM()]);

//   // Synthesize the tool fillers now, so the first caller who triggers a
//   // calendar lookup hears the phrase immediately instead of waiting ~300ms for
//   // it — which would be covering latency with latency.
//   await prewarmPhrases(allFillerPhrases());

//   // ── HTTP server ───────────────────────────────────────────────────────────
//   const server = http.createServer(app);

//   // ── WebSocket server ──────────────────────────────────────────────────────
//   // Attach to the same HTTP server on path /ws/media
//   const wss = new WebSocketServer({ server, path: '/ws/media' });

//   wss.on('connection', (ws, req) => {
//     logger.info(`[wss] New connection from ${req.socket.remoteAddress}`);
//     handleMediaStream(ws);
//   });

//   wss.on('error', (err) => {
//     logger.error(`[wss] Server error: ${err.message}`);
//   });

//   // ── Cleanup cron ──────────────────────────────────────────────────────────
//   startCleanupCron();

//   // ── Listen ────────────────────────────────────────────────────────────────
//   server.listen(config.port, () => {
//     logger.info(`✅  Server running on port ${config.port}`);
//     logger.info(`   HTTP: ${config.baseUrl}/calls/incoming`);
//     logger.info(`   WS:   ${config.baseUrl.replace('https://', 'wss://')}/ws/media`);
//     console.timeEnd('startup');
//   });

//   // ── Watch-mode warning ────────────────────────────────────────────────────
//   // `node --watch` restarts on any change to a watched file, which kills every
//   // call in progress. This process writes logs and .wav recordings while a call
//   // is running, so watching the project root makes it restart itself mid-call.
//   if (process.execArgv.some((a) => a.startsWith('--watch'))) {
//     const scoped = process.execArgv.some((a) => a.startsWith('--watch-path'));
//     logger.warn(
//       `[main] running in WATCH mode${scoped ? '' : ' with no --watch-path'} — ` +
//       'a file change restarts the process and drops live calls. ' +
//       (scoped ? '' : 'Use: node --watch-path=./src src/index.js') +
//       ' Never use watch mode in production.'
//     );
//   }

//   // ── Graceful shutdown ─────────────────────────────────────────────────────
//   //
//   // Previously this closed the HTTP server and exited. Active calls were never
//   // flushed, so a restart lost the transcript, the lead and the recording for
//   // every call in progress — and `node --watch` restarts often.
//   let shuttingDown = false;

//   const shutdown = async (signal) => {
//     if (shuttingDown) return;      // SIGINT twice should not run this twice
//     shuttingDown = true;

//     const active = [...sessionManager.all()];
//     logger.info(
//       `[main] ${signal} received — shutting down` +
//       (active.length ? ` (${active.length} call(s) in progress)` : '')
//     );

//     // Stop taking new connections first, then save what is in flight.
//     server.close(() => logger.info('[main] HTTP server closed'));

//     // flush() is idempotent, so racing the socket teardown is harmless.
//     const saved = await Promise.allSettled(
//       active.map(async ([callSid, session]) => {
//         try {
//           await session.flush();
//           session.destroy();
//           sessionManager.delete(callSid);
//         } catch (err) {
//           logger.error(`[main] flush failed for ${callSid}: ${err.message}`);
//           throw err;
//         }
//       }),
//     );

//     const ok = saved.filter((r) => r.status === 'fulfilled').length;
//     if (active.length) logger.info(`[main] flushed ${ok}/${active.length} call(s)`);

//     process.exit(0);
//   };

//   process.on('SIGTERM', () => shutdown('SIGTERM'));   // node --watch sends this
//   process.on('SIGINT',  () => shutdown('SIGINT'));
//   process.on('SIGUSR2', () => shutdown('SIGUSR2'));   // nodemon

//   // Give the flush time to finish, but never hang a restart forever.
//   const FORCE_EXIT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 8000);
//   const armForceExit = () => setTimeout(() => {
//     logger.error('[main] shutdown timed out — forcing exit');
//     process.exit(1);
//   }, FORCE_EXIT_MS).unref();
//   process.on('SIGTERM', armForceExit);
//   process.on('SIGINT', armForceExit);
// }

// main().catch((err) => {
//   logger.error(`[main] Fatal: ${err.message}`, { stack: err.stack });
//   process.exit(1);
// });



import 'dotenv/config';
import http from 'http';
import { WebSocketServer } from 'ws';
import { app } from './app.js';
import { config } from './config/index.js';
import { connectDB } from './utils/db.js';
import { startCleanupCron } from './utils/cleanup.js';
import { handleMediaStream } from './websocket/mediaStreamHandler.js';
import { logger } from './utils/logger.js';
import { sessionManager } from './utils/sessionManager.js';
import { warmTTS, prewarmPhrases } from './services/speechService.js';
import { warmLLM } from './agents/companyAgents.js';
import { allFillerPhrases } from './constants/fillers.js';
import { startWatching, stopWatching } from './services/outboundDialer.js';

async function main() {
  // ── Database ──────────────────────────────────────────────────────────────
  console.time('startup');
  await connectDB();

  // Warm both upstreams in parallel so the first caller does not pay for
  // either handshake.
  await Promise.allSettled([warmTTS(), warmLLM()]);

  // Synthesize the tool fillers now, so the first caller who triggers a
  // calendar lookup hears the phrase immediately instead of waiting ~300ms for
  // it — which would be covering latency with latency.
  await prewarmPhrases(allFillerPhrases());

  // ── HTTP server ───────────────────────────────────────────────────────────
  const server = http.createServer(app);

  // ── WebSocket server ──────────────────────────────────────────────────────
  // Attach to the same HTTP server on path /ws/media
  const wss = new WebSocketServer({ server, path: '/ws/media' });

  wss.on('connection', (ws, req) => {
    logger.info(`[wss] New connection from ${req.socket.remoteAddress}`);
    handleMediaStream(ws);
  });

  wss.on('error', (err) => {
    logger.error(`[wss] Server error: ${err.message}`);
  });

  // ── Cleanup cron ──────────────────────────────────────────────────────────
  startCleanupCron();

  // ── Outbound sheet watcher ────────────────────────────────────────────────
  //
  // Off unless OUTBOUND_WATCH=true, and dry-run unless OUTBOUND_DRY_RUN=false.
  // Both default to the safe side on purpose: starting the server should never
  // be the thing that begins cold-calling a list.
  if (config.outbound.watch) {
    const missing = [
      !config.sheet.id && 'SHEET_ID',
      !config.outbound.ctcApiKey && 'SMARTFLO_CTC_API_KEY',
      !config.outbound.apiToken && 'SMARTFLO_API_TOKEN',
    ].filter(Boolean);

    if (missing.length) {
      logger.error(
        `[main] OUTBOUND_WATCH=true but ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} ` +
        'not set — the watcher is NOT starting. Run: node scripts/check-outbound.js',
      );
    } else {
      startWatching();
      if (config.outbound.dryRun) {
        logger.warn('[main] outbound watcher is in DRY RUN — set OUTBOUND_DRY_RUN=false to place real calls');
      }
    }
  } else if (config.sheet.id) {
    logger.info('[main] outbound watcher is off (OUTBOUND_WATCH is not "true")');
  }

  // ── Listen ────────────────────────────────────────────────────────────────
  server.listen(config.port, () => {
    logger.info(`✅  Server running on port ${config.port}`);
    logger.info(`   HTTP: ${config.baseUrl}/calls/incoming`);
    logger.info(`   WS:   ${config.baseUrl.replace('https://', 'wss://')}/ws/media`);
    console.timeEnd('startup');
  });

  // ── Watch-mode warning ────────────────────────────────────────────────────
  // `node --watch` restarts on any change to a watched file, which kills every
  // call in progress. This process writes logs and .wav recordings while a call
  // is running, so watching the project root makes it restart itself mid-call.
  if (process.execArgv.some((a) => a.startsWith('--watch'))) {
    const scoped = process.execArgv.some((a) => a.startsWith('--watch-path'));
    logger.warn(
      `[main] running in WATCH mode${scoped ? '' : ' with no --watch-path'} — ` +
      'a file change restarts the process and drops live calls. ' +
      (scoped ? '' : 'Use: node --watch-path=./src src/index.js') +
      ' Never use watch mode in production.'
    );
  }

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  //
  // Previously this closed the HTTP server and exited. Active calls were never
  // flushed, so a restart lost the transcript, the lead and the recording for
  // every call in progress — and `node --watch` restarts often.
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;      // SIGINT twice should not run this twice
    shuttingDown = true;

    const active = [...sessionManager.all()];
    logger.info(
      `[main] ${signal} received — shutting down` +
      (active.length ? ` (${active.length} call(s) in progress)` : '')
    );

    // Stop taking new connections first, then save what is in flight. The
    // dialer goes first: a scan started during shutdown would claim rows it
    // then never dials, leaving them stuck in "Calling".
    stopWatching();
    server.close(() => logger.info('[main] HTTP server closed'));

    // flush() is idempotent, so racing the socket teardown is harmless.
    const saved = await Promise.allSettled(
      active.map(async ([callSid, session]) => {
        try {
          await session.flush();
          session.destroy();
          sessionManager.delete(callSid);
        } catch (err) {
          logger.error(`[main] flush failed for ${callSid}: ${err.message}`);
          throw err;
        }
      }),
    );

    const ok = saved.filter((r) => r.status === 'fulfilled').length;
    if (active.length) logger.info(`[main] flushed ${ok}/${active.length} call(s)`);

    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));   // node --watch sends this
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGUSR2', () => shutdown('SIGUSR2'));   // nodemon

  // Give the flush time to finish, but never hang a restart forever.
  const FORCE_EXIT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 8000);
  const armForceExit = () => setTimeout(() => {
    logger.error('[main] shutdown timed out — forcing exit');
    process.exit(1);
  }, FORCE_EXIT_MS).unref();
  process.on('SIGTERM', armForceExit);
  process.on('SIGINT', armForceExit);
}

main().catch((err) => {
  logger.error(`[main] Fatal: ${err.message}`, { stack: err.stack });
  process.exit(1);
});