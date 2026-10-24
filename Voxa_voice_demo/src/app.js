// import express from 'express';
// import callRoutes from './routes/callRoutes.js';
// import { errorHandler } from './middleware/errorHandler.js';
// import callrecordingRoutes from './routes/callrecordingRoutes.js';


// const app = express();

// // Smartflo posts JSON; keep urlencoded too so either content type parses.
// app.use(express.urlencoded({ extended: false }));
// app.use(express.json());

// // Health check
// app.get('/health', (_, res) => res.json({ 
//     status: 'ok',
//     message: "pstn-SV-Agent-EL-smartflo server version second is live!", 
//     ts: new Date().toISOString() }));

// // Call routes
// app.use('/calls', callRoutes);
// app.use('/calls', callrecordingRoutes);

// // Global error handler
// app.use(errorHandler);

// export { app };




import express from 'express';
import callRoutes from './routes/callRoutes.js';
import callRecordingRoutes from './routes/callRecordingRoutes.js';
import outboundRoutes from './routes/outboundRoutes.js';
import { errorHandler } from './middleware/errorHandler.js';


const app = express();

// CORS middleware allowing frontend dashboard access
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, Range');
  res.header('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Smartflo posts JSON; keep urlencoded too so either content type parses.
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Health check
app.get('/health', (_, res) => res.json({ 
    status: 'ok',
    message: "pstn DG-Agent-EL server version first is live!", 
    ts: new Date().toISOString() }));

// Call routes
app.use('/calls', callRoutes);
// GET /calls/recordings/:callSid
app.use('/calls', callRecordingRoutes);

// Outbound dialling. Guarded by OUTBOUND_API_KEY inside every handler — these
// routes can make a phone ring, so they are never served unauthenticated.
app.use('/outbound', outboundRoutes);

// Global error handler
app.use(errorHandler);

export { app };