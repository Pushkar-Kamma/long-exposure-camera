import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { CameraMotionTracker } from '../public/motion-core.js';

function hash(x, y) {
  let n = Math.imul(x + 193, 374761393) + Math.imul(y + 719, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295 * 2 - 1;
}

function noise(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const sx = x - ix;
  const sy = y - iy;
  const fx = sx * sx * (3 - 2 * sx);
  const fy = sy * sy * (3 - 2 * sy);
  return (hash(ix, iy) * (1 - fx) + hash(ix + 1, iy) * fx) * (1 - fy) +
    (hash(ix, iy + 1) * (1 - fx) + hash(ix + 1, iy + 1) * fx) * fy;
}

function background(x, y) {
  return 110 + 48 * noise(x / 3.7, y / 3.7) + 26 * noise(x / 8.3, y / 8.3) +
    12 * Math.sin(x * 0.51 + y * 0.17);
}

function scene({ width = 160, height = 90, dx = 0, dy = 0, angle = 0, subject = null,
  flat = null, inconsistent = false, periodic = false } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const frequency = 2 * Math.PI / (typeof periodic === 'number' ? periodic : 8);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cx = x - dx - width / 2;
      const cy = y - dy - height / 2;
      const u = cx * cos + cy * sin + width / 2 + (inconsistent && x > width / 2 ? 3 : 0);
      const v = -cx * sin + cy * cos + height / 2;
      let value = flat ?? (periodic ? 100 + 50 * Math.cos(u * frequency) * Math.cos(v * frequency) : background(u, v));
      if (subject && x - dx >= subject.x && x - dx < subject.x + subject.width &&
          y - dy >= subject.y && y - dy < subject.y + subject.height) {
        value = 225 + 24 * noise((x - dx - subject.x) / 2.3, (y - dy - subject.y) / 2.3);
      }
      const p = (y * width + x) * 4;
      data[p] = data[p + 1] = data[p + 2] = value;
      data[p + 3] = 255;
    }
  }
  return { width, height, data };
}

function closeShift(result, dx, dy, tolerance = 0.35) {
  assert.equal(result.accepted, true, result.reason);
  assert.ok(Math.abs(result.dx - dx) <= tolerance, `dx ${result.dx}, expected ${dx}`);
  assert.ok(Math.abs(result.dy - dy) <= tolerance, `dy ${result.dy}, expected ${dy}`);
  assert.ok(result.confidence > 0.5 && result.confidence <= 1);
  assert.ok(result.matches >= 6);
  assert.equal(typeof result.reason, 'string');
  assert.equal(typeof result.moved, 'boolean');
}

function sample(frame, x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const p = (y0 * frame.width + x0) * 4;
  const data = frame.data;
  const stride = frame.width * 4;
  return (data[p] * (1 - fx) + data[p + 4] * fx) * (1 - fy) +
    (data[p + stride] * (1 - fx) + data[p + stride + 4] * fx) * fy;
}

function retainedShape(tracker) {
  const seen = new Set();
  const result = { objects: 0, slots: 0, bytes: 0 };
  function visit(value) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    result.objects++;
    if (ArrayBuffer.isView(value)) {
      result.bytes += value.byteLength;
      return;
    }
    result.slots += Object.keys(value).length;
    for (const child of Object.values(value)) visit(child);
  }
  visit(tracker);
  return result;
}

test('reference identity and signed subpixel offsets in landscape and portrait', t => {
  let maximumError = 0;
  for (const [width, height] of [[160, 90], [90, 160]]) {
    for (const [dx, dy] of [[0.35, -0.65], [-1.4, 0.8], [2.25, -1.75], [-2.6, 2.3]]) {
      const tracker = new CameraMotionTracker();
      const first = tracker.update(scene({ width, height }));
      closeShift(first, 0, 0, 0);
      assert.equal(first.moved, false);
      const result = tracker.update(scene({ width, height, dx, dy }));
      closeShift(result, dx, dy);
      maximumError = Math.max(maximumError, Math.abs(result.dx - dx), Math.abs(result.dy - dy));
    }
    t.diagnostic(`maximum representative signed subpixel error: ${maximumError.toFixed(4)} analysis pixels`);
  }
});

test('dark/flat/repeated scenes and a lone moving light cannot establish a reference', () => {
  const tracker = new CameraMotionTracker();
  for (const frame of [scene({ flat: 0 }), scene({ flat: 8 }), scene({ flat: 95 }),
    scene({ periodic: true }), scene({ flat: 4, subject: { x: 50, y: 30, width: 14, height: 14 } })]) {
    const result = tracker.update(frame);
    assert.equal(result.accepted, false);
    assert.match(result.reason, /dark|texture/i);
    assert.equal(result.confidence, 0);
    assert.equal(tracker.reference, null);
  }
  // Rejected frames have not entered the GPU stack: the later textured frame
  // becomes the actual zero-offset anchor, not a fabricated match to darkness.
  closeShift(tracker.update(scene({ dx: 2, dy: -1 })), 0, 0, 0);
  closeShift(tracker.update(scene({ dx: 2.8, dy: -1.6 })), 0.8, -0.6);
  const reference = tracker.reference;
  assert.equal(tracker.update(scene({ flat: 90 })).accepted, false);
  assert.equal(tracker.reference, reference);
  closeShift(tracker.update(scene({ dx: 2, dy: -1 })), 0, 0);
});

test('malformed, transparent, and changed dimensions reject without resetting the anchor', () => {
  const tracker = new CameraMotionTracker();
  closeShift(tracker.update(scene()), 0, 0);
  const reference = tracker.reference;
  const transparent = scene();
  transparent.data[3] = 0;
  for (const frame of [null, {}, { width: NaN, height: 90, data: new Uint8ClampedArray() },
    { width: -160, height: 90, data: new Uint8ClampedArray() },
    { width: 160.5, height: 90, data: new Uint8ClampedArray() },
    { width: 160, height: 90, data: new Uint8Array(160 * 90 * 4) },
    { width: 160, height: 90, data: new Uint8ClampedArray(12) }, scene({ width: 161 }),
    scene({ width: 90, height: 160 }), transparent]) {
    const result = tracker.update(frame);
    assert.equal(result.accepted, false);
    assert.ok(result.reason.length > 10);
    assert.equal(result.confidence, 0);
    assert.equal(result.moved, false);
    assert.ok(Number.isFinite(result.dx) && Number.isFinite(result.dy));
    assert.equal(tracker.reference, reference);
  }
  closeShift(tracker.update(scene({ dx: -0.7, dy: 1.2 })), -0.7, 1.2);
});

test('equal periodic peaks never become arbitrary cycle corrections, including cycles beyond the drift limit', () => {
  for (const [width, height] of [[160, 90], [90, 160]]) {
    for (const period of [5.5, 8, 12, 18, 24, 32]) {
      const tracker = new CameraMotionTracker();
      for (const [dx, dy] of [[0, 0], [0.4, -0.7], [period + 2, 0], [-period - 1.5, period], [0, 0]]) {
        const result = tracker.update(scene({ width, height, periodic: period, dx, dy }));
        assert.equal(result.accepted, false, `period ${period}, shift ${dx},${dy}: ${JSON.stringify(result)}`);
        assert.equal(result.confidence, 0);
        assert.equal(result.dx, 0);
        assert.equal(result.dy, 0);
        assert.equal(tracker.reference, null);
      }
      closeShift(tracker.update(scene({ width, height })), 0, 0, 0);
      closeShift(tracker.update(scene({ width, height, dx: -1.2, dy: 0.8 })), -1.2, 0.8);
      assert.equal(tracker.update(scene({ width, height, periodic: period, dx: period + 2 })).accepted, false);
      closeShift(tracker.update(scene({ width, height })), 0, 0);
    }
  }
});

test('minority bright moving foreground and two obscured patches leave background consensus intact', () => {
  const tracker = new CameraMotionTracker();
  const subject = { x: 48, y: 34, width: 24, height: 20 };
  closeShift(tracker.update(scene({ subject })), 0, 0);
  const moved = tracker.update(scene({ dx: 1.25, dy: -0.8, subject: { ...subject, x: 90 } }));
  closeShift(moved, 1.25, -0.8);
  assert.ok(Math.abs(moved.dx - 43.25) > 40, 'must not follow the foreground');

  const occlusionTracker = new CameraMotionTracker();
  const first = occlusionTracker.update(scene());
  closeShift(first, 0, 0);
  for (const width of [24, 65]) {
    const result = occlusionTracker.update(scene({
      dx: -1.2, dy: 0.65, subject: { x: 6, y: 4, width, height: 24 }
    }));
    closeShift(result, -1.2, 0.65);
    assert.ok(result.matches < first.matches, 'occluded reference patches must be excluded');
  }
});

test('a whole moving foreground row or column leaves the separated eight-patch background majority usable', () => {
  for (const [width, height, vertical] of [[160, 90, false], [90, 160, true]]) {
    const tracker = new CameraMotionTracker();
    const first = tracker.update(scene({ width, height }));
    closeShift(first, 0, 0);
    assert.equal(first.matches, 12);
    for (const [dx, dy, motion] of [[0, 0, 2], [1.25, -0.8, 4], [-1.2, 0.65, -2]]) {
      const frame = scene({ width, height, dx, dy });
      const foreground = scene({
        width, height, dx: dx + (vertical ? 0 : motion), dy: dy + (vertical ? motion : 0)
      });
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (vertical ? x < width * 2 / 3 : y < height * 2 / 3) continue;
          const p = (y * width + x) * 4;
          frame.data.set(foreground.data.subarray(p, p + 4), p);
        }
      }
      const result = tracker.update(frame);
      closeShift(result, dx, dy);
      assert.equal(result.matches, 8, 'exclude the complete independently moving band');
      assert.ok(Math.abs((vertical ? result.dy - dy : result.dx - dx) - motion) > 1.5,
        'must not follow the moving foreground');
    }
  }
});

test('large shifts, gradual excessive drift, rotation, and split motion reject, then recover', () => {
  const tracker = new CameraMotionTracker();
  closeShift(tracker.update(scene()), 0, 0);
  const reference = tracker.reference;
  for (const frame of [scene({ dx: 14, dy: 0 }), scene({ dx: -18, dy: 7 }),
    scene({ dx: 0, dy: 10 }), scene({ angle: 3 * Math.PI / 180 }),
    scene({ angle: -6 * Math.PI / 180 }), scene({ inconsistent: true })]) {
    const result = tracker.update(frame);
    assert.equal(result.accepted, false, JSON.stringify(result));
    assert.equal(result.confidence, 0);
    assert.match(result.reason, /consensus|movement|rotation/i);
    assert.equal(tracker.reference, reference);
    closeShift(tracker.update(scene({ dx: 0.25, dy: -0.4 })), 0.25, -0.4);
  }
  for (const dx of [2, 4, 6, 7.5]) closeShift(tracker.update(scene({ dx })), dx, 0);
  assert.equal(tracker.update(scene({ dx: 9 })).accepted, false);
  assert.equal(tracker.update(scene({ dx: 22 })).accepted, false);
  closeShift(tracker.update(scene()), 0, 0);
  for (const dy of [2, 4]) closeShift(tracker.update(scene({ dy })), 0, dy);
  assert.equal(tracker.update(scene({ dy: 5.5 })).accepted, false);
  closeShift(tracker.update(scene()), 0, 0);
});

test('reference-based jitter stays accurate with fixed memory and bounded offsets over 240 frames', t => {
  const tracker = new CameraMotionTracker();
  const reused = scene();
  closeShift(tracker.update(reused), 0, 0);
  const reference = tracker.reference;
  const shape = retainedShape(tracker);
  assert.ok(shape.bytes < 12000, JSON.stringify(shape));
  assert.ok(reference.patches.length <= 12);
  let maximumError = 0;
  for (let i = 0; i < 240; i++) {
    const dx = 2.3 * Math.sin(i * 0.23);
    const dy = 1.8 * Math.cos(i * 0.17);
    reused.data.set(scene({ dx, dy }).data);
    const result = tracker.update(reused);
    closeShift(result, dx, dy);
    maximumError = Math.max(maximumError, Math.abs(result.dx - dx), Math.abs(result.dy - dy));
    assert.ok(Math.abs(result.dx) <= 8 && Math.abs(result.dy) <= 4.5);
    assert.equal(tracker.reference, reference);
    assert.deepEqual(retainedShape(tracker), shape);
  }
  closeShift(tracker.update(scene()), 0, 0);
  t.diagnostic(`240 reused-buffer frames: maximum axis error ${maximumError.toFixed(4)} px; retained ${shape.bytes} typed-array bytes with unchanged object/slot counts`);
});

test('truth-based stacking reduces jitter blur without freezing a moving bright subject', t => {
  const tracker = new CameraMotionTracker();
  const subject = { x: 20, y: 33, width: 12, height: 20 };
  const reference = scene({ subject });
  closeShift(tracker.update(reference), 0, 0);
  const unaligned = new Float64Array(160 * 90);
  const aligned = new Float64Array(160 * 90);
  const truth = new Float64Array(160 * 90);
  const frames = 32;
  let trackedSubjectTravel = 0;
  for (let i = 0; i < frames; i++) {
    const dx = 2.3 * Math.sin(i * 0.7);
    const dy = 1.8 * Math.cos(i * 0.61);
    const currentSubject = { ...subject, x: subject.x + i * 2.1 };
    const frame = scene({ dx, dy, subject: currentSubject });
    const result = tracker.update(frame);
    closeShift(result, dx, dy);
    trackedSubjectTravel = currentSubject.x + dx - result.dx - subject.x;
    for (let y = 10; y < 80; y++) {
      for (let x = 10; x < 150; x++) {
        const p = y * 160 + x;
        unaligned[p] += frame.data[p * 4] / frames;
        aligned[p] += sample(frame, x + result.dx, y + result.dy) / frames;
        truth[p] += sample(frame, x + dx, y + dy) / frames;
      }
    }
  }
  let rawError = 0;
  let alignedError = 0;
  let truthError = 0;
  let pixels = 0;
  for (let y = 10; y < 80; y++) {
    if (y >= 29 && y <= 57) continue;
    for (let x = 10; x < 150; x++) {
      const p = y * 160 + x;
      rawError += (unaligned[p] - reference.data[p * 4]) ** 2;
      alignedError += (aligned[p] - reference.data[p * 4]) ** 2;
      truthError += (aligned[p] - truth[p]) ** 2;
      pixels++;
    }
  }
  assert.ok(alignedError < rawError * 0.15, `${alignedError / pixels} aligned vs ${rawError / pixels} raw MSE`);
  assert.ok(truthError / pixels < 0.4, `alignment must agree with known camera truth: ${truthError / pixels}`);
  assert.ok(trackedSubjectTravel > 64, 'the subject should still travel through the aligned stack');
  t.diagnostic(`background MSE: unaligned ${(rawError / pixels).toFixed(3)}, aligned ${(alignedError / pixels).toFixed(3)}, truth difference ${(truthError / pixels).toFixed(3)}`);
});

test('host runtime measurement for precomputed 160x90 analysis images (not phone timing)', t => {
  const tracker = new CameraMotionTracker();
  const frames = Array.from({ length: 40 }, (_, i) => scene({
    dx: 1.8 * Math.sin(i * 0.22), dy: 1.4 * Math.cos(i * 0.19)
  }));
  const reference = scene();
  const referenceStart = performance.now();
  closeShift(tracker.update(reference), 0, 0);
  const referenceMs = performance.now() - referenceStart;
  for (const frame of frames) assert.equal(tracker.update(frame).accepted, true);
  const durations = [];
  for (let i = 0; i < 200; i++) {
    const start = performance.now();
    const result = tracker.update(frames[i % frames.length]);
    durations.push(performance.now() - start);
    assert.equal(result.accepted, true, result.reason);
  }
  durations.sort((a, b) => a - b);
  const sparse = scene({ flat: 110 });
  sparse.data.set(reference.data.subarray(0, 160 * 30 * 4));
  const sparseTracker = new CameraMotionTracker();
  const excessive = scene({ dx: 25, dy: 10 });
  let sparseMs = 0;
  let rejectedMs = 0;
  for (let i = 0; i < 20; i++) {
    let start = performance.now();
    const sparseResult = sparseTracker.update(sparse);
    sparseMs += performance.now() - start;
    assert.equal(sparseResult.accepted, false);
    assert.equal(sparseTracker.reference, null);
    start = performance.now();
    const rejected = tracker.update(excessive);
    rejectedMs += performance.now() - start;
    assert.equal(rejected.accepted, false);
  }
  t.diagnostic(`Host ${process.platform}/${process.arch} ${process.version}: reference ${referenceMs.toFixed(2)} ms, update mean ${(durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(2)} ms, p50 ${durations[100].toFixed(2)} ms, p95 ${durations[190].toFixed(2)} ms; no phone timing claim.`);
  t.diagnostic(`Rejection cost, 20 frames each: sparse non-separated pre-reference mean ${(sparseMs / 20).toFixed(2)} ms; established-reference excessive-shift mean ${(rejectedMs / 20).toFixed(2)} ms. Sparse pre-reference attempts repeat uniqueness work until a usable reference arrives.`);
});
