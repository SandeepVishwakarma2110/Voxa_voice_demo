import { Router } from 'express';
import {
  handleIncomingCall,
  handleStatusCallback,
  getActiveSessions,
} from '../controllers/callController.js';

const router = Router();

// Smartflo does not sign its webhooks, so there is no signature to validate.
// If this endpoint is public, restrict it at the network layer (allowlist
// Smartflo's egress IPs) rather than trusting the body.
router.post('/incoming', handleIncomingCall);
router.post('/status', handleStatusCallback);

// Debug (disable or add auth in production)
router.get('/sessions', getActiveSessions);

export default router;