import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { boundedString, uuidSchema } from '../../src/validators/consistency-registry.js';

const VALID_UUID = '3f2b8c1e-5d4a-4b7e-9a1c-2e6f8d0b7a43';

test('uuidSchema accepts a valid UUID and returns it unchanged', () => {
  assert.equal(uuidSchema.parse(VALID_UUID), VALID_UUID);
});

for (const bad of ['', 'not-a-uuid', '3f2b8c1e5d4a4b7e9a1c2e6f8d0b7a43', 42, null, undefined, {}]) {
  test('uuidSchema rejects ' + JSON.stringify(bad), () => {
    assert.equal(uuidSchema.safeParse(bad).success, false);
  });
}

test('boundedString accepts a value up to the maximum length', () => {
  assert.equal(boundedString(5).parse('abcde'), 'abcde');
});

test('boundedString rejects an empty string', () => {
  assert.equal(boundedString(5).safeParse('').success, false);
});

test('boundedString rejects a value over the maximum length', () => {
  assert.equal(boundedString(5).safeParse('abcdef').success, false);
});

test('boundedString rejects non-strings', () => {
  assert.equal(boundedString(5).safeParse(5).success, false);
});

test('primitives compose into one object schema', () => {
  const schema = z.object({ id: uuidSchema, name: boundedString(8) });
  assert.deepEqual(schema.parse({ id: VALID_UUID, name: 'quest' }), {
    id: VALID_UUID,
    name: 'quest',
  });
  assert.equal(schema.safeParse({ id: VALID_UUID }).success, false);
});

test('one primitive is reused by two schemas', () => {
  const quest = z.object({ questId: uuidSchema, title: boundedString(32) });
  const reward = z.object({ rewardId: uuidSchema, userId: uuidSchema });
  assert.equal(quest.shape.questId, uuidSchema);
  assert.equal(reward.shape.rewardId, uuidSchema);
  assert.equal(reward.shape.userId, uuidSchema);
  assert.equal(quest.safeParse({ questId: 'bad', title: 'x' }).success, false);
  assert.equal(reward.safeParse({ rewardId: 'bad', userId: VALID_UUID }).success, false);
});
