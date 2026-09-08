import test from 'node:test';
import assert from 'node:assert/strict';
import { PREFERENCES_KEY, validatePreferences, loadPreferences, savePreferences } from '../public/preferences.js';

const valid = { duration: 45, mode: 'trails', delay: '5', quality: '720' };
const memoryStorage = () => {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, value); }
  };
};

test('preferences validate every supported choice and strip unrelated fields', () => {
  for (const duration of [1, '45', 600]) {
    for (const mode of ['average', 'trails']) {
      for (const delay of ['0', '3', '5', '10']) {
        for (const quality of ['720', '1080']) {
          const input = { duration, mode, delay, quality, unexpected: 'ignored' };
          assert.deepEqual(validatePreferences(input), { duration: Number(duration), mode, delay, quality });
          assert.equal(input.unexpected, 'ignored');
        }
      }
    }
  }
});

test('preferences reject missing fields, unsupported choices and out-of-range durations', () => {
  for (const input of [null, undefined, 'settings', [], {}, 3]) {
    assert.throws(() => validatePreferences(input));
  }
  for (const [key, values] of Object.entries({
    duration: ['', 0, -1, 601, 1.5, NaN, Infinity],
    mode: ['max', '', null],
    delay: ['1', '600', 5, null],
    quality: ['480', '4k', 720, null]
  })) {
    for (const value of values) assert.throws(() => validatePreferences({ ...valid, [key]: value }));
    const missing = { ...valid };
    delete missing[key];
    assert.throws(() => validatePreferences(missing));
  }
});

test('preferences load empty storage without overwriting anything', () => {
  const storage = memoryStorage();
  assert.equal(loadPreferences(storage), null);
  assert.equal(storage.getItem(PREFERENCES_KEY), null);
});

test('preferences save and load with injected storage round-trip all settings', () => {
  const storage = memoryStorage();
  savePreferences(valid, storage);
  assert.deepEqual(JSON.parse(storage.getItem(PREFERENCES_KEY)), valid);
  assert.deepEqual(loadPreferences(storage), valid);
  savePreferences({ ...valid, duration: '600', quality: '1080' }, storage);
  assert.deepEqual(loadPreferences(storage), { ...valid, duration: 600, quality: '1080' });
});

test('preferences reject corrupt JSON and invalid persisted data without silently replacing it', () => {
  const storage = memoryStorage();
  for (const data of ['{broken', 'null', '[]', '{"duration":45}', JSON.stringify({ ...valid, mode: 'bad' })]) {
    storage.setItem(PREFERENCES_KEY, data);
    assert.throws(() => loadPreferences(storage));
    assert.equal(storage.getItem(PREFERENCES_KEY), data);
  }
});

test('invalid saves leave previously remembered settings intact', () => {
  const storage = memoryStorage();
  savePreferences(valid, storage);
  assert.throws(() => savePreferences({ ...valid, duration: 601 }, storage));
  assert.deepEqual(loadPreferences(storage), valid);
});

test('unavailable or full localStorage errors propagate for the UI to display', () => {
  const unavailable = new DOMException('Storage blocked', 'SecurityError');
  const full = new DOMException('Storage full', 'QuotaExceededError');
  assert.throws(() => loadPreferences({ getItem() { throw unavailable; } }), error => error === unavailable);
  assert.throws(() => savePreferences(valid, { setItem() { throw full; } }), error => error === full);
});
