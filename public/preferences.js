import { parseDuration } from './capture.js';

export const PREFERENCES_KEY = 'still-camera-settings-v1';

export function validatePreferences(value) {
  if (!value || typeof value !== 'object') throw new Error('Saved camera settings are invalid.');
  const duration = parseDuration(value.duration);
  if (!['average', 'trails'].includes(value.mode) ||
      !['0', '3', '5', '10'].includes(value.delay) ||
      !['720', '1080'].includes(value.quality)) {
    throw new Error('Saved camera settings are invalid.');
  }
  return { duration, mode: value.mode, delay: value.delay, quality: value.quality };
}

export function loadPreferences(storage = localStorage) {
  const saved = storage.getItem(PREFERENCES_KEY);
  return saved === null ? null : validatePreferences(JSON.parse(saved));
}

export function savePreferences(value, storage = localStorage) {
  storage.setItem(PREFERENCES_KEY, JSON.stringify(validatePreferences(value)));
}
