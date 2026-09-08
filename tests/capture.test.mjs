import test from 'node:test';
import assert from 'node:assert/strict';
import { CaptureClock, parseDuration, formatTime } from '../public/capture.js';

test('duration accepts every whole second, including both limits', () => {
  for (let seconds = 1; seconds <= 600; seconds++) {
    assert.equal(parseDuration(seconds), seconds);
    assert.equal(parseDuration(String(seconds)), seconds);
  }
});

test('duration rejects invalid custom entries', () => {
  for (const value of ['', ' ', 'abc', '1.5', -1, 0, 0.5, 600.1, 601, Infinity, NaN, null, undefined]) {
    assert.throws(() => parseDuration(value), /whole number of seconds from 1 to 600/);
    assert.throws(() => new CaptureClock(value), /whole number/);
  }
});

test('clock waits for a frame and correctly accepts a zero timestamp', () => {
  const clock = new CaptureClock(1);
  assert.equal(clock.elapsed(100000), 0);
  assert.equal(clock.complete(100000), false);
  assert.equal(clock.stalled(100000), false);
  assert.equal(clock.capturedSeconds, 0);
  clock.addFrame(0);
  clock.addFrame(40);
  assert.equal(clock.startedAt, 0);
  assert.equal(clock.frames, 2);
  assert.equal(clock.elapsed(999), 999);
  assert.equal(clock.complete(999), false);
  assert.equal(clock.complete(1000), true);
  assert.equal(clock.complete(1001), true);
  assert.equal(clock.elapsed(-1), 0);
  assert.equal(clock.capturedSeconds, 0.04);
});

test('full 600-second exposure never completes early or depends on frame count', () => {
  const clock = new CaptureClock(600);
  const start = 4321;
  for (let offset = 0; offset < 600000; offset += 33) {
    clock.addFrame(start + offset);
    assert.equal(clock.complete(start + offset), false);
    assert.equal(clock.stalled(start + offset), false);
  }
  assert.equal(clock.frames, 18182);
  assert.equal(clock.complete(start + 599999), false);
  assert.equal(clock.complete(start + 600000), true);
  assert.equal(clock.complete(start + 600001), true);
  assert.equal(clock.duration, 600000);
  assert.equal(clock.capturedSeconds, 599.973);
});

test('stall timeout has a strict boundary, recovers, and preserves actual frame span', () => {
  const clock = new CaptureClock(600);
  clock.addFrame(0);
  assert.equal(clock.stalled(2500), false);
  assert.equal(clock.stalled(2501), true);
  assert.equal(clock.stalled(100, 100), false);
  assert.equal(clock.stalled(101, 100), true);
  clock.addFrame(3000);
  assert.equal(clock.stalled(3001), false);
  assert.equal(clock.capturedSeconds, 3);
  assert.equal(clock.elapsed(10000), 10000);
  assert.equal(clock.capturedSeconds, 3);
});

test('time formatting clamps negative time and floors at minute boundaries', () => {
  for (const [seconds, expected] of [[-1, '00:00'], [0, '00:00'], [0.99, '00:00'], [1, '00:01'], [59.99, '00:59'], [60, '01:00'], [599.99, '09:59'], [600, '10:00']]) {
    assert.equal(formatTime(seconds), expected);
  }
});
