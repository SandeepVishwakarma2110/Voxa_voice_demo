import { logger } from '../utils/logger.js';

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  logger.error(`[errorHandler] ${err.message}`, { stack: err.stack });
  const status = err.status ?? err.statusCode ?? 500;
  res.status(status).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
}
