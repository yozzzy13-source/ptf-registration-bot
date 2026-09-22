import test from 'node:test';
import assert from 'node:assert/strict';

import {
  looksLikeMatchSubmission,
  parseMatchMessageV2,
  validateMatchScore
} from './results.js';

test('parses retirement score written with en dashes', () => {
  const text = [
    'Final',
    'Div. D',
    'Ilia Fomichev - Chen Shan 7\u20136 (7-4), 2\u20132 ret. P2'
  ].join('\n');

  assert.equal(looksLikeMatchSubmission(text), true);

  const parsed = parseMatchMessageV2(text);
  assert.deepEqual(
    {
      p1Raw: parsed.p1Raw,
      p2Raw: parsed.p2Raw,
      technicalResult: parsed.technicalResult,
      retiredPlayer: parsed.retiredPlayer,
      s1p1: parsed.s1p1,
      s1p2: parsed.s1p2,
      s1tb1: parsed.s1tb1,
      s1tb2: parsed.s1tb2,
      s2p1: parsed.s2p1,
      s2p2: parsed.s2p2
    },
    {
      p1Raw: 'Ilia Fomichev',
      p2Raw: 'Chen Shan',
      technicalResult: 'RET',
      retiredPlayer: 'p2',
      s1p1: '7',
      s1p2: '6',
      s1tb1: '7',
      s1tb2: '4',
      s2p1: '2',
      s2p2: '2'
    }
  );

  assert.deepEqual(validateMatchScore(parsed), {
    ok: true,
    winner: 'p1',
    set3Mode: '',
    technicalResult: 'RET'
  });
});

test('parses the original final message with bare ret as P2 retirement', () => {
  const parsed = parseMatchMessageV2([
    'Final',
    'Div. D',
    'Ilia Fomichev - Chen Shan 7\u20136 (7-4), 2\u20132 ret.'
  ].join('\n'));

  assert.equal(parsed.retiredPlayer, 'p2');
  assert.equal(parsed.s1p1, '7');
  assert.equal(parsed.s1p2, '6');
  assert.equal(parsed.s1tb1, '7');
  assert.equal(parsed.s1tb2, '4');
  assert.equal(parsed.s2p1, '2');
  assert.equal(parsed.s2p2, '2');
});

test('does not treat a parenthesized tie-break as a standalone set', () => {
  const parsed = parseMatchMessageV2('Player One - Player Two score (7-4) ret. P2');
  assert.equal(parsed.hasScore, false);
});
