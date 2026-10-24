// import winston from 'winston';

// const { combine, timestamp, colorize, printf, json } = winston.format;

// const devFormat = printf(({ level, message, timestamp, ...meta }) => {
//   const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
//   return `${timestamp} [${level}] ${message}${extra}`;
// });

// export const logger = winston.createLogger({
//   level: process.env.LOG_LEVEL || 'info',
//   format: combine(timestamp({ format: 'HH:mm:ss.SSS' }), json()),
//   transports: [
//     new winston.transports.Console({
//       format: combine(timestamp({ format: 'HH:mm:ss.SSS' }), colorize(), devFormat),
//     }),
//     //new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
//     new winston.transports.File({ filename: 'logs/combinedTest2.log' }),
//   ],
// });


// export default logger;


import winston from 'winston';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../');
const LOG_FILE_PATH = path.join(PROJECT_ROOT, 'logs', 'combinedTest2.log');

const { combine, timestamp, colorize, printf, json } = winston.format;

const devFormat = printf(({ level, message, timestamp, ...meta }) => {
  const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${timestamp} [${level}] ${message}${extra}`;
});

// Base console transport
const transports = [
  new winston.transports.Console({
    format: process.env.NODE_ENV === 'production' 
      ? combine(timestamp({ format: 'HH:mm:ss.SSS' }), json()) // Structured JSON for prod aggregators
      : combine(timestamp({ format: 'HH:mm:ss.SSS' }), colorize(), devFormat),
  })
];

// Only write to local log files if NOT in production
if (process.env.NODE_ENV !== 'production') {
  transports.push(new winston.transports.File({ filename: LOG_FILE_PATH }));
}

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(timestamp({ format: 'HH:mm:ss.SSS' }), json()),
  transports,
});

export default logger;