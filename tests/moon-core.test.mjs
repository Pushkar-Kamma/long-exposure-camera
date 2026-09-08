import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMoon, MoonStack } from '../public/moon-core.js';
import { createMoonSimulation } from '../public/moon-simulation.js';

function decode(value) {
  const encoded = value / 255;
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
}

function encode(value) {
  return 255 * (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055);
}

function sampleLinear(frame, x, y, channel) {
  if (x < 0 || x > frame.width - 1 || y < 0 || y > frame.height - 1) return null;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const x1 = Math.min(frame.width - 1, x0 + 1);
  const y1 = Math.min(frame.height - 1, y0 + 1);
  const value = (xx, yy) => decode(frame.data[(yy * frame.width + xx) * 4 + channel]);
  return (value(x0, y0) * (1 - fx) + value(x1, y0) * fx) * (1 - fy) +
    (value(x0, y1) * (1 - fx) + value(x1, y1) * fx) * fy;
}

function scene({ width = 96, height = width, radius = width * 0.3, centerX = (width - 1) / 2,
  centerY = (height - 1) / 2, crescent = false, flat = false, inverted = false, color = false } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x - centerX;
      const v = y - centerY;
      const subject = u * u + v * v < radius * radius &&
        (!crescent || u > 0.35 * Math.sqrt(Math.max(0, radius * radius - v * v)));
      const texture = flat ? 0 : (inverted ? -1 : 1) *
        (14 * Math.sin(u * 0.59 + v * 0.11) * Math.cos(v * 0.41) + 9 * Math.cos(u * 0.24 - v * 0.33));
      const p = (y * width + x) * 4;
      data[p] = subject ? 160 + texture : 8 + y % 9;
      data[p + 1] = subject ? (color ? 110 + texture * 0.6 : 160 + texture) : 12 + x % 5;
      data[p + 2] = subject ? (color ? 65 + texture * 0.35 : 160 + texture) : 4 + (y + x) % 4;
      data[p + 3] = 255;
    }
  }
  return { width, height, data };
}

function translate(frame, dx, dy) {
  const data = new Uint8ClampedArray(frame.data.length);
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const p = (y * frame.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        data[p + c] = Math.round(encode(sampleLinear(frame, Math.max(0, Math.min(frame.width - 1, x - dx)),
          Math.max(0, Math.min(frame.height - 1, y - dy)), c)));
      }
      data[p + 3] = 255;
    }
  }
  return { width: frame.width, height: frame.height, data };
}

function noisy(frame, amount, seed = 19) {
  let state = seed;
  const data = new Uint8ClampedArray(frame.data);
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      // The sum of uniforms approximates symmetric sensor noise without a global RNG.
      const noise = random() + random() + random() + random() - 2;
      data[i + c] = Math.max(0, Math.min(245, data[i + c] + noise * amount * Math.sqrt(3)));
    }
  }
  return { width: frame.width, height: frame.height, data };
}

function blur(frame, passes = 5) {
  let current = new Uint8ClampedArray(frame.data);
  for (let pass = 0; pass < passes; pass++) {
    const output = new Uint8ClampedArray(current);
    for (let y = 1; y < frame.height - 1; y++) {
      for (let x = 1; x < frame.width - 1; x++) {
        const p = (y * frame.width + x) * 4;
        for (let c = 0; c < 3; c++) {
          output[p + c] = (current[p + c] * 4 + current[p - 4 + c] + current[p + 4 + c] +
            current[p - frame.width * 4 + c] + current[p + frame.width * 4 + c]) / 8;
        }
      }
    }
    current = output;
  }
  return { width: frame.width, height: frame.height, data: current };
}

test('detects a small Moon at detector scale and reports its real detail limit', () => {
  const frame = scene({ width: 128, radius: 4, flat: true });
  const result = analyzeMoon(frame);
  assert.equal(result.ok, true, result.reason);
  assert.ok(Math.abs(result.centerX - 63.5) < 0.2);
  assert.ok(Math.abs(result.centerY - 63.5) < 0.2);
  assert.ok(result.diameter >= 7 && result.diameter <= 11);
  assert.equal(result.detailLimited, true);
  assert.match(result.warning, /few pixels|limited/);
  assert.equal(analyzeMoon(frame, { minDiameter: 16 }).ok, false);
  const tiny = analyzeMoon(scene({ width: 64, radius: 1.6, flat: true }));
  assert.equal(tiny.ok, false);
  assert.match(tiny.reason, /tiny|no isolated/i);
});

test('allows crescent and partial illuminated outlines without imposing a circular bright disk', () => {
  for (const radius of [20, 38]) {
    const result = analyzeMoon(scene({ radius, crescent: true }));
    assert.equal(result.ok, true, result.reason);
    assert.ok(result.diameter > radius * 1.5);
    assert.ok(result.centerX > 47.5);
  }
  const crescent = scene({ radius: 38, crescent: true });
  const stack = new MoonStack();
  assert.equal(stack.add(crescent).accepted, true);
  assert.equal(stack.add(translate(crescent, -2.25, 1.5)).accepted, true);
  assert.equal(stack.finish().stats.used, 2);
});

test('rejects empty, dark, edge-cut, ambiguous and malformed input explicitly', () => {
  const dark = scene({ radius: 0 });
  assert.equal(analyzeMoon(dark).ok, false);
  assert.equal(analyzeMoon(noisy(dark, 7)).ok, false);
  const edge = analyzeMoon(scene({ centerX: 7, radius: 24 }));
  assert.equal(edge.ok, false);
  assert.match(edge.reason, /edge|cut off/);
  const two = scene({ width: 128, centerX: 30, radius: 16 });
  const second = scene({ width: 128, centerX: 96, radius: 16 });
  for (let i = 0; i < two.data.length; i++) two.data[i] = Math.max(two.data[i], second.data[i]);
  assert.match(analyzeMoon(two).reason, /several bright/i);
  for (const frame of [null, {}, { width: 2, height: 2, data: new Uint8ClampedArray(4) },
    { width: -1, height: 2, data: new Uint8ClampedArray() }]) {
    assert.equal(analyzeMoon(frame).ok, false);
  }
  const transparent = scene();
  transparent.data[3] = 0;
  assert.match(analyzeMoon(transparent).reason, /opaque/);
  assert.throws(() => new MoonStack().finish(), /No usable Moon/);
  assert.throws(() => new MoonStack({ maxFrames: 0 }), /maxFrames/);
});

test('rejects clipping including one saturated color channel, never attempting recovery', () => {
  const clipped = scene();
  for (let y = 42; y < 49; y++) {
    for (let x = 42; x < 49; x++) clipped.data[(y * clipped.width + x) * 4] = 255;
  }
  const analysis = analyzeMoon(clipped);
  assert.equal(analysis.ok, false);
  assert.ok(analysis.clippedFraction > 0);
  assert.equal(analysis.score, 0);
  assert.match(analysis.reason, /lower.*exposure.*native.*cannot be recovered/i);
  const stack = new MoonStack();
  for (let i = 0; i < 4; i++) assert.equal(stack.add(clipped).accepted, false);
  assert.equal(stack.seen, 4);
  assert.equal(stack.clipped, 4);
  assert.equal(stack.rejected, 4);
  assert.equal(stack.candidates.length, 0);
  assert.throws(() => stack.finish(), /No usable.*lower exposure/i);
  const white = scene();
  white.data.fill(255);
  const whiteAnalysis = analyzeMoon(white);
  assert.equal(whiteAnalysis.ok, false);
  assert.equal(whiteAnalysis.clippedFraction, 1);
  assert.match(whiteAnalysis.reason, /lower capture exposure/i);
});

test('preblurred, limb-masked quality ranks texture over blur and excessive noise', () => {
  const sharp = scene({ width: 128 });
  const sharpScore = analyzeMoon(sharp).score;
  const blurredScore = analyzeMoon(blur(sharp, 10)).score;
  const noisyBlurScore = analyzeMoon(noisy(blur(sharp, 10), 18)).score;
  assert.ok(sharpScore > blurredScore * 1.8, `${sharpScore} vs ${blurredScore}`);
  assert.ok(sharpScore > noisyBlurScore * 1.4, `${sharpScore} vs noisy blur ${noisyBlurScore}`);
  assert.ok(analyzeMoon(noisy(sharp, 25)).score < sharpScore * 1.5, 'high noise must not earn a large sharpness bonus');
  const stack = new MoonStack();
  assert.equal(stack.add(sharp).accepted, true);
  const rejected = stack.add(blur(sharp, 10));
  assert.equal(rejected.accepted, false);
  assert.match(rejected.reason, /blur/i);
});

test('single imported image is copied exactly and honestly labelled as a single-frame result', () => {
  const input = scene({ color: true });
  const original = new Uint8ClampedArray(input.data);
  const stack = new MoonStack();
  assert.equal(stack.add(input).accepted, true);
  input.data.fill(0);
  const result = stack.finish();
  assert.equal(result.stats.used, 1);
  assert.match(result.warning, /single-frame.*no stacking improvement/i);
  assert.deepEqual(result.image.data, original);
  assert.deepEqual(result.reference.data, original);
  result.image.data.fill(0);
  assert.deepEqual(result.reference.data, original);
  assert.deepEqual(stack.finish().image.data, original);
});

test('exact duplicate photos and repeated decoded video frames never fill the pool or imply independent denoising', () => {
  const first = scene();
  const stack = new MoonStack();
  assert.equal(stack.add(first).accepted, true);
  for (let i = 0; i < 30; i++) {
    const duplicate = stack.add({ ...first, data: new Uint8ClampedArray(first.data) });
    assert.equal(duplicate.accepted, false);
    assert.match(duplicate.reason, /exact duplicate.*no independent exposure/i);
    assert.equal(duplicate.stored, 1);
  }
  const single = stack.finish();
  assert.equal(single.stats.seen, 31);
  assert.equal(single.stats.usable, 1);
  assert.equal(single.stats.used, 1);
  assert.equal(single.stats.duplicateRejected, 30);
  assert.equal(single.stats.rejected, 30);
  assert.match(single.warning, /single-frame.*no stacking improvement/i);
  const second = noisy(first, 3);
  assert.equal(stack.add(second).accepted, true);
  for (const frame of [first, second, first, second]) assert.equal(stack.add(frame).accepted, false);
  const result = stack.finish();
  assert.equal(result.stats.used, 2);
  assert.equal(result.stats.usable, 2);
  assert.equal(result.stats.duplicateRejected, 34);
  assert.equal(result.stats.seen, result.stats.used + result.stats.rejected + result.stats.notSelected);
});

test('featureless images fall back honestly instead of registering unrelated noise', () => {
  const frame = scene({ flat: true });
  const stack = new MoonStack();
  assert.equal(stack.add(frame).accepted, true);
  assert.equal(stack.add(translate(frame, 2, -3)).accepted, false);
  const result = stack.finish();
  assert.equal(result.stats.used, 1);
  assert.equal(result.stats.alignmentRejected, 1);
  assert.match(result.warning, /single-frame/i);
});

test('restarts an unregistrable featureless anchor without blending it into later detailed frames', () => {
  const flat = scene({ flat: true });
  const sharp = scene();
  const companion = noisy(translate(sharp, 2.25, -1.5), 3);
  const frames = [flat, sharp, companion];
  const stack = new MoonStack();
  assert.equal(stack.add(flat).accepted, true);
  assert.ok(stack.anchor.template.count < 32 || stack.anchor.template.variance < stack.anchor.template.count);
  const settled = stack.add(sharp);
  assert.equal(settled.accepted, true, settled.reason);
  assert.equal(settled.stored, 1, 'the unverifiable old pool must be discarded, not blended');
  const single = stack.finish();
  assert.deepEqual(single.image.data, sharp.data);
  assert.match(single.warning, /single-frame/i);
  assert.match(single.warning, /discarded.*insufficient registration texture/i);
  assert.equal(stack.add(companion).accepted, true);
  const result = stack.finish();
  assert.equal(result.stats.seen, 3);
  assert.equal(result.stats.usable, 2);
  assert.equal(result.stats.used, 2);
  assert.equal(result.stats.rejected, 1);
  assert.equal(result.stats.anchorResets, 1);
  assert.equal(result.stats.anchorDiscarded, 1);
  assert.equal(result.stats.alignmentRejected, 0);
  assert.equal(result.stats.notSelected, 0);
  assert.deepEqual(result.stats.alignments.map(alignment => alignment.index).sort(), [1, 2]);
  assert.deepEqual(result.reference.data, frames[result.stats.referenceIndex].data);
  const shifts = [[0, 0], [0, 0], [2.25, -1.5]];
  for (const alignment of result.stats.alignments) {
    assert.ok(Math.abs(alignment.dx - (shifts[alignment.index][0] - shifts[result.stats.referenceIndex][0])) < 0.3);
    assert.ok(Math.abs(alignment.dy - (shifts[alignment.index][1] - shifts[result.stats.referenceIndex][1])) < 0.3);
  }
  assert.equal(stack.add(scene({ inverted: true })).accepted, false, 'a good replacement anchor still rejects unrelated texture');
  assert.equal(stack.add(sharp).accepted, false, 'replacement candidates still reject exact duplicates');
  const checked = stack.finish();
  assert.equal(checked.stats.anchorResets, 1);
  assert.equal(checked.stats.alignmentRejected, 1);
  assert.equal(checked.stats.duplicateRejected, 1);
  assert.equal(checked.stats.seen, checked.stats.used + checked.stats.rejected + checked.stats.notSelected);
});

test('rejects changed scale, dimensions and unrelated texture instead of warping frames', () => {
  const stack = new MoonStack();
  assert.equal(stack.add(scene()).accepted, true);
  const scaled = stack.add(scene({ radius: 18 }));
  assert.equal(scaled.accepted, false);
  assert.match(scaled.reason, /scale|zoom/);
  const dimensions = stack.add(scene({ width: 128 }));
  assert.equal(dimensions.accepted, false);
  assert.match(dimensions.reason, /dimensions/);
  const unrelated = stack.add(scene({ inverted: true }));
  assert.equal(unrelated.accepted, false);
  assert.match(unrelated.reason, /matching.*texture/);
  const result = stack.finish();
  assert.equal(result.stats.seen, 4);
  assert.equal(result.stats.used, 1);
  assert.equal(result.stats.rejected, 3);
  assert.equal(result.stats.scaleRejected, 1);
  assert.equal(result.stats.dimensionRejected, 1);
});

test('simulation is deterministic, lazy, original, and contains both shift signs and bad examples', () => {
  const simulation = createMoonSimulation({ width: 64, height: 64, count: 14, seed: 7 });
  assert.equal(Array.isArray(simulation.frames), false);
  const first = [...simulation.frames];
  const repeated = [...simulation.frames];
  assert.deepEqual(first, repeated);
  assert.equal(first.length, 14);
  assert.ok(first.some(frame => frame.shiftX < 0) && first.some(frame => frame.shiftX > 0));
  assert.ok(first.some(frame => frame.shiftY < 0) && first.some(frame => frame.shiftY > 0));
  assert.ok(first.some(frame => !Number.isInteger(frame.shiftX)));
  assert.ok(first.some(frame => frame.kind === 'blurred'));
  assert.ok(first.some(frame => frame.kind === 'clipped'));
  assert.notDeepEqual(first[0].data, simulation.truth.data);
  assert.notDeepEqual(simulation.truth.data, createMoonSimulation({ width: 64, height: 64, seed: 8 }).truth.data);
  assert.throws(() => createMoonSimulation({ count: 0 }), /Simulation/);
});

test('every simulation frame can be transferred to a worker without detaching truth or future frames', () => {
  const simulation = createMoonSimulation({ count: 4, width: 64, height: 64 });
  const expected = [...simulation.frames];
  const truth = new Uint8ClampedArray(simulation.truth.data);
  let index = 0;
  for (const frame of simulation.frames) {
    assert.notEqual(frame.data.buffer, simulation.truth.data.buffer);
    const transferred = structuredClone(frame, { transfer: [frame.data.buffer] });
    assert.equal(frame.data.byteLength, 0);
    assert.deepEqual(transferred.data, expected[index++].data);
    assert.deepEqual(simulation.truth.data, truth);
  }
  assert.equal(index, 4);
  assert.deepEqual([...simulation.frames], expected);
});

test('registered textured frames work in both blurred-first and sharp-first order without resetting a good anchor', () => {
  const frames = [...createMoonSimulation({ count: 16, width: 128, height: 128, seed: 41 }).frames];
  for (const firstTwo of [[frames[6], frames[0]], [frames[0], frames[6]]]) {
    const stack = new MoonStack();
    const order = [...firstTwo, ...frames.filter(frame => !firstTwo.includes(frame))];
    assert.equal(stack.add(order[0]).accepted, true);
    assert.ok(stack.anchor.template.count >= 32 && stack.anchor.template.variance >= stack.anchor.template.count);
    for (const frame of order.slice(1)) stack.add(frame);
    const result = stack.finish();
    const reference = order[result.stats.referenceIndex];
    assert.equal(reference.kind, 'normal');
    assert.ok(result.stats.used >= 8);
    assert.ok(result.stats.blurRejected >= 1);
    assert.equal(result.stats.anchorResets, 0);
    assert.equal(result.stats.anchorDiscarded, 0);
    for (const alignment of result.stats.alignments) {
      const frame = order[alignment.index];
      assert.ok(Math.hypot(alignment.dx - (frame.shiftX - reference.shiftX),
        alignment.dy - (frame.shiftY - reference.shiftY)) < 0.4);
    }
    assert.equal(result.stats.seen, result.stats.used + result.stats.rejected + result.stats.notSelected);
  }
});

test('known-truth synthetic stack improves actual surface fidelity, not merely a gradient metric', t => {
  const simulation = createMoonSimulation();
  const frames = [...simulation.frames];
  const stack = new MoonStack({ maxFrames: 24 });
  const started = performance.now();
  for (const frame of frames) stack.add(frame);
  const result = stack.finish();
  const elapsed = performance.now() - started;
  const referenceFrame = frames[result.stats.referenceIndex];
  assert.equal(referenceFrame.kind, 'normal');
  assert.deepEqual(result.reference.data, referenceFrame.data, 'comparison is an actual retained input, not an invented baseline');
  assert.ok(result.stats.used >= 12);
  assert.ok(result.stats.used <= 24);
  assert.equal(result.stats.clipped, frames.filter(frame => frame.kind === 'clipped').length);
  assert.ok(result.stats.blurRejected >= frames.filter(frame => frame.kind === 'blurred').length);
  assert.equal(result.image.width, simulation.width);
  assert.equal(result.image.height, simulation.height);
  let maximumShiftError = 0;
  for (const alignment of result.stats.alignments) {
    const input = frames[alignment.index];
    assert.equal(input.kind, 'normal', 'clipped/blurred data must not enter the science stack');
    const error = Math.hypot(alignment.dx - (input.shiftX - referenceFrame.shiftX),
      alignment.dy - (input.shiftY - referenceFrame.shiftY));
    maximumShiftError = Math.max(maximumShiftError, error);
    assert.ok(error < 0.4, `frame ${input.index} translation error ${error}`);
  }
  let referenceError = 0;
  let stackError = 0;
  let samples = 0;
  const centerX = (simulation.width - 1) / 2 + referenceFrame.shiftX;
  const centerY = (simulation.height - 1) / 2 + referenceFrame.shiftY;
  const radius = simulation.width * 0.3 * 0.85;
  for (let y = 0; y < simulation.height; y++) {
    for (let x = 0; x < simulation.width; x++) {
      assert.equal(result.image.data[(y * simulation.width + x) * 4 + 3], 255);
      if (Math.hypot(x - centerX, y - centerY) > radius) continue;
      for (let c = 0; c < 3; c++) {
        // Both images are compared in the chosen reference's coordinates, using known shifts.
        const expected = encode(sampleLinear(simulation.truth, x - referenceFrame.shiftX, y - referenceFrame.shiftY, c));
        const p = (y * simulation.width + x) * 4 + c;
        referenceError += (result.reference.data[p] - expected) ** 2;
        stackError += (result.image.data[p] - expected) ** 2;
        samples++;
      }
    }
  }
  const referenceMse = referenceError / samples;
  const stackMse = stackError / samples;
  const gain = 10 * Math.log10(referenceMse / stackMse);
  assert.ok(stackMse < referenceMse * 0.4, `surface MSE ${referenceMse} -> ${stackMse}`);
  assert.ok(gain > 4);
  assert.equal(result.stats.seen, result.stats.used + result.stats.rejected + result.stats.notSelected);
  t.diagnostic(`seed=2026, used=${result.stats.used}/${frames.length}, surface MSE ${referenceMse.toFixed(3)} -> ${stackMse.toFixed(3)}, PSNR +${gain.toFixed(2)} dB, maximum shift error ${maximumShiftError.toFixed(3)} px, processing ${elapsed.toFixed(0)} ms (host CPU only)`);
});

test('translation-only linear averaging has no channel leakage, row wrap, fabricated extrema or black-edge bias', () => {
  const source = scene({ color: true });
  const shifts = [[0, 0], [3, -2], [-4, 3], [1.5, -1.25], [-2.25, -3.5]];
  const frames = shifts.map(([dx, dy]) => translate(source, dx, dy));
  const stack = new MoonStack();
  for (const frame of frames) assert.equal(stack.add(frame).accepted, true);
  const result = stack.finish();
  assert.equal(result.stats.used, shifts.length);
  const referenceShift = shifts[result.stats.referenceIndex];
  for (const alignment of result.stats.alignments) {
    assert.ok(Math.abs(alignment.dx - (shifts[alignment.index][0] - referenceShift[0])) < 0.3);
    assert.ok(Math.abs(alignment.dy - (shifts[alignment.index][1] - referenceShift[1])) < 0.3);
  }
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      for (let c = 0; c < 3; c++) {
        const values = result.stats.alignments.map(alignment =>
          sampleLinear(frames[alignment.index], x + alignment.dx, y + alignment.dy, c)).filter(value => value !== null);
        const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
        const actual = result.image.data[(y * source.width + x) * 4 + c];
        assert.ok(Math.abs(actual - Math.round(encode(mean))) <= 1, `non-convex output/channel/edge error at ${x},${y},${c}`);
        assert.ok(actual >= Math.floor(encode(Math.min(...values))) && actual <= Math.ceil(encode(Math.max(...values))));
      }
    }
  }
});

test('hundreds of reused input buffers retain only bounded copied top candidates', () => {
  const input = scene({ width: 48 });
  const original = new Uint8ClampedArray(input.data);
  const stack = new MoonStack({ maxFrames: 999 });
  assert.equal(stack.maxFrames, 32);
  for (let i = 0; i < 350; i++) {
    input.data[0] = 8 + i % 16;
    input.data[4] = 7 + Math.floor(i / 16);
    const added = stack.add(input);
    assert.equal(added.accepted, true, added.reason);
    assert.ok(added.stored <= 32);
    assert.equal(added.seen, i + 1);
  }
  input.data.fill(0);
  const result = stack.finish();
  assert.equal(result.stats.seen, 350);
  assert.equal(result.stats.usable, 350);
  assert.equal(result.stats.used, 32);
  assert.equal(result.stats.notSelected, 318);
  assert.equal(stack.candidates.length, 32);
  assert.ok(result.stats.retainedBytes <= 32 * original.byteLength + input.width * input.height * 12);
  const reference = new Uint8ClampedArray(original);
  reference[0] = 8 + result.stats.referenceIndex % 16;
  reference[4] = 7 + Math.floor(result.stats.referenceIndex / 16);
  assert.deepEqual(result.reference.data, reference);
  for (let i = 0; i < original.length; i++) {
    if (i !== 0 && i !== 4) assert.equal(result.image.data[i], original[i]);
  }
});
