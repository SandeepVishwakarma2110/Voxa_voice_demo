// src/routes/outboundRoutes.js
//
// Every route here can make a phone ring. All of them require OUTBOUND_API_KEY
// in an x-api-key header, enforced per handler in the controller rather than by
// a router-level middleware, so adding a route cannot accidentally skip the
// check by being registered above it.

import { Router } from 'express';
import {
  getStatus,
  getLeads,
  postScan,
  postCall,
  postWatch,
} from '../controllers/outboundController.js';

const router = Router();

router.get('/status', getStatus);
router.get('/leads', getLeads);
router.post('/scan', postScan);
router.post('/call', postCall);
router.post('/watch', postWatch);

export default router;