import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCommand } from '../src/telegram/bot.js';
import { areEntriesPaused, setEntriesPaused } from '../src/runtime-controls.js';

test('Telegram commands are normalized and bot suffixes are removed', () => {
  assert.equal(normalizeCommand(' /STATUS@MyTraderBot extra '), '/status');
  assert.equal(normalizeCommand('/pause'), '/pause');
});

test('runtime entry pause can be changed without mutating frozen config', () => {
  const initial = areEntriesPaused();
  try {
    setEntriesPaused(true);
    assert.equal(areEntriesPaused(), true);
    setEntriesPaused(false);
    assert.equal(areEntriesPaused(), false);
  } finally {
    setEntriesPaused(initial);
  }
});
