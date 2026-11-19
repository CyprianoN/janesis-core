import { z } from 'zod';

/**
 * Clerk webhook payload, structural validation only (IADP Phase 8, DEC-008-01, W-A). It requires a
 * JSON object and tolerates unknown fields. No Clerk event types, field names or signature details
 * are established here; provider-specific tightening belongs to the phase that implements Clerk
 * webhook processing.
 */
export const clerkWebhookPayloadSchema = z.looseObject({});
