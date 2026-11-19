import { z } from 'zod';

/**
 * Reward-processing job payload, structural validation only (IADP Phase 8, DEC-009-01, J-A). It
 * requires a JSON object and tolerates unknown fields. No job payload fields or delivery details
 * are established here; the phase that implements this job defines its payload contract.
 */
export const rewardProcessingJobPayloadSchema = z.looseObject({});
