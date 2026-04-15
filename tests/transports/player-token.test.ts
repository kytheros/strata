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
