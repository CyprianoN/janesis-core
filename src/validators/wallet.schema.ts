import { z } from 'zod';

/**
 * Thirdweb webhook payload, structural validation only (IADP Phase 8, DEC-008-01, W-A). It requires
 * a JSON object and tolerates unknown fields. No Thirdweb event types, field names or signature
 * details are established here; provider-specific tightening belongs to the phase that implements
 * Thirdweb webhook processing.
 */
export const thirdwebWebhookPayloadSchema = z.looseObject({});
