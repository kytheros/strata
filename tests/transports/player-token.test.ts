import { test, expect } from 'vitest';
import { mintPlayerToken, verifyPlayerToken } from '../../src/transports/player-token.js';

const SECRET = 'test-secret-abc';

test('mint/verify roundtrip', () => {
  const token = mintPlayerToken({ playerId: 'pc1', worldId: 'story-3' }, SECRET);
  const claims = verifyPlayerToken(token, SECRET);
  expect(claims.playerId).toBe('pc1');
  expect(claims.worldId).toBe('story-3');
  expect(claims.v).toBe(2);
});

test('tampered token fails verification', () => {
  const token = mintPlayerToken({ playerId: 'pc1', worldId: 'story-3' }, SECRET);
  const parts = token.split('.');
  const bad = parts[0] + '.' + parts[1] + '.tamper';
  expect(() => verifyPlayerToken(bad, SECRET)).toThrow();
});

test('wrong secret fails verification', () => {
  const token = mintPlayerToken({ playerId: 'pc1', worldId: 'story-3' }, SECRET);
  expect(() => verifyPlayerToken(token, 'wrong')).toThrow();
});

// Issue #3-C: token rotation grace period
test('verifyPlayerToken with fallback secret accepts token signed by previous secret', () => {
  const previousSecret = 'old-secret-xyz';
  const currentSecret = 'new-secret-abc';
  // Token signed with old secret
  const token = mintPlayerToken({ playerId: 'pc1', worldId: 'story-3' }, previousSecret);
  // Should succeed when previous secret provided as fallback
  const claims = verifyPlayerToken(token, currentSecret, previousSecret);
  expect(claims.playerId).toBe('pc1');
  expect(claims.worldId).toBe('story-3');
});

test('verifyPlayerToken with fallback secret does NOT accept token with wrong secrets', () => {
  const token = mintPlayerToken({ playerId: 'pc1', worldId: 'story-3' }, 'totally-different');
  expect(() => verifyPlayerToken(token, 'current', 'previous')).toThrow();
});

test('verifyPlayerToken without fallback still rejects previous-secret tokens', () => {
  const previousSecret = 'old-secret-xyz';
  const token = mintPlayerToken({ playerId: 'pc1', worldId: 'story-3' }, previousSecret);
  // No fallback provided — should still throw
  expect(() => verifyPlayerToken(token, 'new-secret-abc')).toThrow();
});
