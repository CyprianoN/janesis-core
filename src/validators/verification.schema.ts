import { z } from 'zod';

/**
 * X API response used in X verification, structural validation only (IADP Phase 8, DEC-008-01,
 * W-A). It requires a JSON object and tolerates unknown fields. No X endpoint, field names or
 * adapter behavior are established here; provider-specific tightening belongs to the phase that
 * implements the X adapter.
 */
export const xApiResponseSchema = z.looseObject({});

/**
 * Quest-verification job payload, structural validation only (IADP Phase 8, DEC-009-01, J-A). It
 * requires a JSON object and tolerates unknown fields. No job payload fields or delivery details
 * are established here; the phase that implements this job defines its payload contract.
 */
export const questVerificationJobPayloadSchema = z.looseObject({});
