import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCommand, TELEGRAM_COMMANDS } from '../src/telegram/bot.js';
import { areEntriesPaused, setEntriesPaused } from '../src/runtime-controls.js';

test('Telegram commands are normalized and bot suffixes are removed', () => {
  assert.equal(normalizeCommand(' /STATUS@MyTraderBot extra '), '/status');
  assert.equal(normalizeCommand('/pause'), '/pause');
});

test('Telegram slash menu contains every supported user command', () => {
  assert.deepEqual(TELEGRAM_COMMANDS.map(item => item.command), ['status', 'portfolio', 'scan', 'pause', 'resume', 'risk', 'help']);
  assert.ok(TELEGRAM_COMMANDS.every(item => item.description.length > 0 && item.description.length <= 256));
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
