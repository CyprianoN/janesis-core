import { z } from 'zod';

/**
 * Shared runtime validation primitives (IADP Phase 8, WP8-04). Provider-agnostic and free of
 * domain rules: validators import nothing from domain, application, infrastructure or transport.
 */

/** A UUID string, as used for Rewards, Quests and other uuid primary keys. */
export const uuidSchema = z.uuid();

/** A non-empty string of at most `max` characters. Values are never trimmed or altered. */
export const boundedString = (max: number) => z.string().min(1).max(max);
