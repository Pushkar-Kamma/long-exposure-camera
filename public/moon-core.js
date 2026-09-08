const MAX_FRAMES = 32;
const CLIP_LEVEL = 250;
const linear = Float32Array.from({ length: 256 }, (_, value) => {
  const encoded = value / 255;
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
});

function encode(value) {
  return Math.round(255 * (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055));
}

function failure(reason, extra = {}) {
  return { ok: false, reason, centerX: 0, centerY: 0, diameter: 0, clippedFraction: 0, score: 0, background: 0, ...extra };
}

function invalidFrame(frame) {
  if (!frame || !Number.isInteger(frame.width) || !Number.isInteger(frame.height) ||
      frame.width < 1 || frame.height < 1 || frame.width * frame.height > 4096 * 4096 ||
      !(frame.data instanceof Uint8ClampedArray) || frame.data.length !== frame.width * frame.height * 4) {
    return 'Expected a valid RGBA image with positive dimensions and a Uint8ClampedArray pixel buffer.';
  }
  return null;
}

function smoothImage(input, width, height) {
  const horizontal = new Float32Array(input.length);
  const output = new Float32Array(input.length);
  const weights = [1, 4, 6, 4, 1];
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -2; k <= 2; k++) sum += weights[k + 2] * input[row + Math.max(0, Math.min(width - 1, x + k))];
      horizontal[row + x] = sum / 16;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -2; k <= 2; k++) sum += weights[k + 2] * horizontal[Math.max(0, Math.min(height - 1, y + k)) * width + x];
      output[y * width + x] = sum / 16;
    }
  }
  return output;
}

function inspect(frame, options = {}) {
  const invalid = invalidFrame(frame);
  if (invalid) return { analysis: failure(invalid) };
  const { width, height, data } = frame;
  const length = width * height;
  const gray = new Float32Array(length);
  const histogram = new Uint32Array(256);
  let saturatedPixels = 0;
  for (let i = 0; i < length; i++) {
    const p = i * 4;
    if (data[p + 3] !== 255) {
      return { analysis: failure('Use an opaque image, not a transparent layer. Import the original camera photograph.') };
    }
    if (data[p] >= CLIP_LEVEL || data[p + 1] >= CLIP_LEVEL || data[p + 2] >= CLIP_LEVEL) saturatedPixels++;
    gray[i] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
    histogram[Math.round(gray[i])]++;
  }
  let background = 0;
  let cumulative = 0;
  while (background < 255 && cumulative + histogram[background] < length * 0.2) cumulative += histogram[background++];
  const smooth = smoothImage(gray, width, height);
  let peak = 0;
  for (const value of smooth) peak = Math.max(peak, value);
  if (peak - background < 24 || background > 100) {
    if (saturatedPixels > length * 0.1) {
      return { analysis: failure('The image is clipped or nearly saturated. Lower capture exposure or import correctly exposed native frames; lost surface detail cannot be recovered.',
        { background, clippedFraction: saturatedPixels / length }) };
    }
    return { analysis: failure('No isolated bright Moon against dark sky was found. Aim at the Moon or import a correctly exposed native frame.', { background }) };
  }
  const threshold = background + Math.max(18, (peak - background) * 0.22);
  const visited = new Uint8Array(length);
  const queue = new Int32Array(length);
  let subject = null;
  let runnerUp = null;
  for (let start = 0; start < length; start++) {
    if (visited[start] || smooth[start] <= threshold) continue;
    let head = 0;
    let tail = 1;
    queue[0] = start;
    visited[start] = 1;
    let mass = 0;
    let weightedX = 0;
    let weightedY = 0;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    let clipped = 0;
    while (head < tail) {
      const i = queue[head++];
      const x = i % width;
      const y = Math.floor(i / width);
      const weight = smooth[i] - background;
      mass += weight;
      weightedX += x * weight;
      weightedY += y * weight;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      const p = i * 4;
      if (Math.max(data[p], data[p + 1], data[p + 2]) >= CLIP_LEVEL) clipped++;
      // Explicit column checks prevent the right edge joining the next row.
      if (x > 0 && !visited[i - 1] && smooth[i - 1] > threshold) { visited[i - 1] = 1; queue[tail++] = i - 1; }
      if (x + 1 < width && !visited[i + 1] && smooth[i + 1] > threshold) { visited[i + 1] = 1; queue[tail++] = i + 1; }
      if (y > 0 && !visited[i - width] && smooth[i - width] > threshold) { visited[i - width] = 1; queue[tail++] = i - width; }
      if (y + 1 < height && !visited[i + width] && smooth[i + width] > threshold) { visited[i + width] = 1; queue[tail++] = i + width; }
    }
    const component = { mass, centerX: weightedX / mass, centerY: weightedY / mass, minX, maxX, minY, maxY, area: tail, clipped };
    if (!subject || mass > subject.mass) { runnerUp = subject; subject = component; }
    else if (!runnerUp || mass > runnerUp.mass) runnerUp = component;
  }
  if (!subject) return { analysis: failure('No usable lunar subject was found. Check aim and exposure.', { background }) };
  const spanX = subject.maxX - subject.minX + 1;
  const spanY = subject.maxY - subject.minY + 1;
  const diameter = Math.max(spanX, spanY);
  const analysis = {
    ok: true,
    centerX: subject.centerX,
    centerY: subject.centerY,
    diameter,
    clippedFraction: subject.clipped / subject.area,
    score: 0,
    background,
    area: subject.area,
    bounds: { left: subject.minX, top: subject.minY, right: subject.maxX, bottom: subject.maxY },
    threshold,
    detailLimited: diameter < 32,
    warning: diameter < 32 ? 'The Moon occupies few pixels; expect limited real surface detail. Use optical magnification or a higher-resolution native photo.' : null
  };
  const fail = reason => ({ analysis: { ...analysis, ok: false, reason }, smooth });
  if (subject.clipped) {
    return fail('The lunar subject is clipped or nearly saturated. Lower capture exposure or import correctly exposed native frames; lost surface detail cannot be recovered.');
  }
  const minimum = Number.isFinite(options.minDiameter) ? Math.max(3, options.minDiameter) : 7;
  if (diameter < minimum || subject.area < 16) return fail('The Moon is too tiny to measure reliably. Use optical magnification or import a higher-resolution native frame.');
  if (subject.minX <= 1 || subject.minY <= 1 || subject.maxX >= width - 2 || subject.maxY >= height - 2) {
    return fail('The lunar subject is cut off or too close to the image edge. Reframe with dark sky around the whole illuminated subject.');
  }
  if (runnerUp && runnerUp.mass > subject.mass * 0.35 && runnerUp.area >= 16) {
    return fail('Several bright subjects were found. Crop or aim at one isolated Moon with dark sky around it.');
  }
  if (Math.min(spanX, spanY) / diameter < 0.12 || subject.area / (spanX * spanY) < 0.08) {
    return fail('The bright subject does not have a usable lunar outline. Avoid lights, streaks, and heavily motion-blurred frames.');
  }
  let surfaceEnergy = 0;
  let surfaceSignal = 0;
  let surfaceCount = 0;
  let skyEnergy = 0;
  let skyCount = 0;
  const margin = Math.min(12, Math.max(3, Math.round(diameter * 0.07)));
  for (let y = 3; y < height - 3; y++) {
    for (let x = 3; x < width - 3; x++) {
      const i = y * width + x;
      const dx = (smooth[i + 1] - smooth[i - 1]) / 2;
      const dy = (smooth[i + width] - smooth[i - width]) / 2;
      const energy = dx * dx + dy * dy;
      const interior = x >= margin && x < width - margin && y >= margin && y < height - margin &&
        x > subject.minX && x < subject.maxX && y > subject.minY && y < subject.maxY &&
        smooth[i] > threshold && smooth[i - margin] > threshold && smooth[i + margin] > threshold &&
        smooth[i - margin * width] > threshold && smooth[i + margin * width] > threshold &&
        smooth[i - margin * width - margin] > threshold && smooth[i + margin * width + margin] > threshold &&
        smooth[i - margin * width + margin] > threshold && smooth[i + margin * width - margin] > threshold;
      if (interior) {
        surfaceEnergy += energy;
        surfaceSignal += smooth[i] - background;
        surfaceCount++;
      } else if (smooth[i] < background + 12 && smooth[i - 3] < threshold && smooth[i + 3] < threshold &&
        smooth[i - 3 * width] < threshold && smooth[i + 3 * width] < threshold) {
        skyEnergy += energy;
        skyCount++;
      }
    }
  }
  // Preblur and sky-noise subtraction stop a raw gradient score rewarding sensor noise.
  const noiseEnergy = skyCount ? skyEnergy / skyCount : 0;
  const meanSignal = surfaceSignal / Math.max(1, surfaceCount);
  analysis.score = Math.max(0, surfaceEnergy / Math.max(1, surfaceCount) - 1.5 * noiseEnergy) / Math.max(1, meanSignal * meanSignal);
  analysis.noise = noiseEnergy;
  return { analysis, smooth };
}

/**
 * Detect a bright, isolated lunar candidate; this is not astronomical object identification.
 * minDiameter is measured in this input's pixels. Clipping is rejected, never reconstructed.
 */
export function analyzeMoon(frame, options = {}) {
  return inspect(frame, options).analysis;
}

function registrationMap(smooth, width, height) {
  const horizontal = new Float32Array(smooth.length);
  const output = new Float32Array(smooth.length);
  const radius = 4;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let x = -radius; x <= radius; x++) sum += smooth[row + Math.max(0, Math.min(width - 1, x))];
    for (let x = 0; x < width; x++) {
      horizontal[row + x] = sum / 9;
      sum += smooth[row + Math.min(width - 1, x + radius + 1)] - smooth[row + Math.max(0, x - radius)];
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += horizontal[Math.max(0, Math.min(height - 1, y)) * width + x];
    for (let y = 0; y < height; y++) {
      const i = y * width + x;
      output[i] = smooth[i] - sum / 9;
      sum += horizontal[Math.min(height - 1, y + radius + 1) * width + x] - horizontal[Math.max(0, y - radius) * width + x];
    }
  }
  return output;
}

function makeTemplate(smooth, map, width, height, analysis) {
  const points = [];
  const margin = analysis.diameter < 32 ? 2 : 5;
  const stride = Math.max(1, Math.ceil(Math.sqrt(analysis.area / 2200)));
  const { left, top, right, bottom } = analysis.bounds;
  let sum = 0;
  let sumSquares = 0;
  for (let y = Math.max(margin, top); y <= Math.min(height - margin - 1, bottom); y += stride) {
    for (let x = Math.max(margin, left); x <= Math.min(width - margin - 1, right); x += stride) {
      const i = y * width + x;
      if (smooth[i] <= analysis.threshold || smooth[i - margin] <= analysis.threshold || smooth[i + margin] <= analysis.threshold ||
        smooth[i - margin * width] <= analysis.threshold || smooth[i + margin * width] <= analysis.threshold ||
        smooth[i - margin * width - margin] <= analysis.threshold || smooth[i + margin * width + margin] <= analysis.threshold ||
        smooth[i - margin * width + margin] <= analysis.threshold || smooth[i + margin * width - margin] <= analysis.threshold) continue;
      const value = map[i];
      points.push(x, y, value);
      sum += value;
      sumSquares += value * value;
    }
  }
  const count = points.length / 3;
  return { points: Float32Array.from(points), count, sum, variance: sumSquares - sum * sum / Math.max(1, count) };
}

function correlation(template, map, width, height, dx, dy, parity = -1) {
  let a = 0;
  let aa = 0;
  let b = 0;
  let bb = 0;
  let ab = 0;
  let count = 0;
  const integer = Number.isInteger(dx) && Number.isInteger(dy);
  const points = template.points;
  for (let i = 0; i < points.length; i += 3) {
    if (parity !== -1 && Math.floor(i / 3) % 2 !== parity) continue;
    const x = points[i] + dx;
    const y = points[i + 1] + dy;
    if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return -1;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const p = y0 * width + x0;
    let value;
    if (integer) value = map[p];
    else {
      const fx = x - x0;
      const fy = y - y0;
      const right = x0 + 1 < width ? 1 : 0;
      const down = y0 + 1 < height ? width : 0;
      value = (map[p] * (1 - fx) + map[p + right] * fx) * (1 - fy) +
        (map[p + down] * (1 - fx) + map[p + down + right] * fx) * fy;
    }
    const reference = points[i + 2];
    a += reference;
    aa += reference * reference;
    b += value;
    bb += value * value;
    ab += reference * value;
    count++;
  }
  const varianceA = aa - a * a / Math.max(1, count);
  const varianceB = bb - b * b / Math.max(1, count);
  if (count < 16 || varianceA < count || varianceB < count) return -1;
  return (ab - a * b / count) / Math.sqrt(varianceA * varianceB);
}

function hasRegistrationTexture(template) {
  return template.count >= 32 && template.variance >= template.count;
}

function register(template, map, width, height, referenceAnalysis, analysis) {
  if (!hasRegistrationTexture(template)) return null;
  const coarseX = Math.round(analysis.centerX - referenceAnalysis.centerX);
  const coarseY = Math.round(analysis.centerY - referenceAnalysis.centerY);
  let best = { dx: coarseX, dy: coarseY, correlation: -1 };
  for (let dy = coarseY - 3; dy <= coarseY + 3; dy++) {
    for (let dx = coarseX - 3; dx <= coarseX + 3; dx++) {
      const score = correlation(template, map, width, height, dx, dy);
      if (score > best.correlation) best = { dx, dy, correlation: score };
    }
  }
  for (const step of [0.5, 0.25, 0.125, 0.0625]) {
    const origin = best;
    for (let y = -1; y <= 1; y++) {
      for (let x = -1; x <= 1; x++) {
        if (!x && !y) continue;
        const dx = origin.dx + x * step;
        const dy = origin.dy + y * step;
        const score = correlation(template, map, width, height, dx, dy);
        if (score > best.correlation) best = { dx, dy, correlation: score };
      }
    }
  }
  // High-pass interior texture, not a shared bright silhouette, must agree.
  if (best.correlation < 0.65 || Math.abs(best.dx - coarseX) > 3 || Math.abs(best.dy - coarseY) > 3 ||
      correlation(template, map, width, height, best.dx, best.dy, 0) < 0.5 ||
      correlation(template, map, width, height, best.dx, best.dy, 1) < 0.5) return null;
  return best;
}

function copyFrame(frame) {
  return { width: frame.width, height: frame.height, data: new Uint8ClampedArray(frame.data) };
}

function identicalFrame(a, b) {
  if (a.width !== b.width || a.height !== b.height) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

/**
 * Translation-only lucky imaging. Retains at most 32 copied RGBA candidates plus
 * one bounded sparse registration template; there is no deconvolution or sharpening.
 * Exact duplicates of retained candidates never enter the average.
 */
export class MoonStack {
  constructor({ maxFrames = 24 } = {}) {
    if (!Number.isFinite(maxFrames) || maxFrames < 1) throw new RangeError('maxFrames must be a positive finite number.');
    this.maxFrames = Math.min(MAX_FRAMES, Math.floor(maxFrames));
    this.candidates = [];
    this.anchor = null;
    this.seen = 0;
    this.usable = 0;
    this.rejected = 0;
    this.clipped = 0;
    this.alignmentRejected = 0;
    this.blurRejected = 0;
    this.scaleRejected = 0;
    this.dimensionRejected = 0;
    this.duplicateRejected = 0;
    this.anchorResets = 0;
    this.anchorDiscarded = 0;
  }

  add(frame) {
    this.seen++;
    const duplicate = !invalidFrame(frame) && this.candidates.find(candidate => identicalFrame(frame, candidate.frame));
    if (duplicate) {
      this.rejected++;
      this.duplicateRejected++;
      return {
        accepted: false,
        reason: 'An exact duplicate frame was skipped: it provides no independent exposure. Use distinct photos or wait for the next decoded video frame.',
        analysis: duplicate.analysis,
        stored: this.candidates.length,
        seen: this.seen
      };
    }
    const { analysis, smooth } = inspect(frame);
    const reject = reason => {
      this.rejected++;
      return { accepted: false, reason, analysis, stored: this.candidates.length, seen: this.seen };
    };
    if (analysis.clippedFraction > 0) this.clipped++;
    if (!analysis.ok) return reject(analysis.reason);
    if (frame.width !== frame.height || frame.width > 512) {
      this.dimensionRejected++;
      return reject('Use a square native-resolution lunar crop no larger than 512 pixels (384 recommended).');
    }
    if (this.anchor) {
      if (frame.width !== this.anchor.width || frame.height !== this.anchor.height) {
        this.dimensionRejected++;
        return reject('Frame dimensions changed. Keep the same crop size, orientation, and camera throughout the sequence.');
      }
      if (Math.abs(analysis.diameter / this.anchor.analysis.diameter - 1) > 0.15 ||
          Math.abs(analysis.area / this.anchor.analysis.area - 1) > 0.3) {
        this.scaleRejected++;
        return reject('The lunar scale or illuminated shape changed. Keep the same optical zoom, framing, and subject; frames are not stretched to fit.');
      }
      const anchorHasTexture = hasRegistrationTexture(this.anchor.template);
      if (anchorHasTexture && analysis.score < this.candidates[0].analysis.score * 0.5) {
        this.blurRejected++;
        return reject('This frame is too blurry compared with the sharper frames. Use a shorter exposure and hold the camera steady.');
      }
      const map = registrationMap(smooth, frame.width, frame.height);
      if (!anchorHasTexture) {
        const template = makeTemplate(smooth, map, frame.width, frame.height, analysis);
        if (!hasRegistrationTexture(template)) {
          this.alignmentRejected++;
          return reject('No reliable matching lunar surface texture was found. Use sharper native frames of the same subject, scale, and orientation.');
        }
        // An unfocused first frame cannot establish correspondence. Start a new
        // pool instead of inventing an alignment between it and settled detail.
        const discarded = this.candidates.length;
        this.anchorDiscarded += discarded;
        this.anchorResets++;
        this.rejected += discarded;
        this.usable -= discarded;
        this.candidates = [];
        this.anchor = { width: frame.width, height: frame.height, analysis, template };
      } else if (!register(this.anchor.template, map, frame.width, frame.height, this.anchor.analysis, analysis)) {
        this.alignmentRejected++;
        return reject('No reliable matching lunar surface texture was found. Use sharper native frames of the same subject, scale, and orientation.');
      }
    } else {
      const map = registrationMap(smooth, frame.width, frame.height);
      this.anchor = { width: frame.width, height: frame.height, analysis, template: makeTemplate(smooth, map, frame.width, frame.height, analysis) };
    }
    this.usable++;
    if (this.candidates.length < this.maxFrames || analysis.score > this.candidates[this.candidates.length - 1].analysis.score) {
      const candidate = { frame: copyFrame(frame), analysis, index: this.seen - 1 };
      if (this.candidates.length === this.maxFrames) this.candidates.pop();
      this.candidates.push(candidate);
      this.candidates.sort((a, b) => b.analysis.score - a.analysis.score || a.index - b.index);
    }
    return { accepted: true, analysis, stored: this.candidates.length, seen: this.seen };
  }

  finish() {
    if (!this.candidates.length) throw new Error('No usable Moon frame was collected. Use a larger, sharp, unsaturated Moon with dark sky around it; lower exposure if it is clipped.');
    const best = this.candidates[0];
    const reference = copyFrame(best.frame);
    const { width, height } = reference;
    const { smooth } = inspect(reference);
    const map = registrationMap(smooth, width, height);
    const template = makeTemplate(smooth, map, width, height, best.analysis);
    const aligned = [{ candidate: best, dx: 0, dy: 0, correlation: 1 }];
    let alignmentRejected = this.alignmentRejected;
    let blurRejected = this.blurRejected;
    let finishRejected = 0;
    for (const candidate of this.candidates.slice(1)) {
      if (candidate.analysis.score < best.analysis.score * 0.6) { blurRejected++; finishRejected++; continue; }
      const inspected = inspect(candidate.frame);
      const candidateMap = registrationMap(inspected.smooth, width, height);
      const alignment = register(template, candidateMap, width, height, best.analysis, candidate.analysis);
      if (!alignment) { alignmentRejected++; finishRejected++; continue; }
      aligned.push({ candidate, ...alignment });
    }
    const stats = {
      seen: this.seen,
      usable: this.usable - finishRejected,
      used: aligned.length,
      rejected: this.rejected + finishRejected,
      clipped: this.clipped,
      alignmentRejected,
      blurRejected,
      scaleRejected: this.scaleRejected,
      dimensionRejected: this.dimensionRejected,
      duplicateRejected: this.duplicateRejected,
      anchorResets: this.anchorResets,
      anchorDiscarded: this.anchorDiscarded,
      notSelected: this.usable - this.candidates.length,
      stored: this.candidates.length,
      maxFrames: this.maxFrames,
      retainedBytes: this.candidates.reduce((bytes, candidate) => bytes + candidate.frame.data.byteLength, 0) + this.anchor.template.points.byteLength,
      referenceIndex: best.index,
      referenceScore: best.analysis.score,
      diameter: best.analysis.diameter,
      detailLimited: best.analysis.detailLimited,
      alignments: aligned.map(({ candidate, dx, dy, correlation: score }) => ({ index: candidate.index, dx, dy, correlation: score }))
    };
    let warning = best.analysis.warning;
    if (this.anchorDiscarded) {
      warning = `${warning ? `${warning} ` : ''}Discarded ${this.anchorDiscarded} earlier frame${this.anchorDiscarded === 1 ? '' : 's'} with insufficient registration texture; restarted from a later detailed frame. Earlier frames were not blended.`;
    }
    if (aligned.length === 1) {
      warning = `Single-frame result: only one reliable frame was available; no stacking improvement is claimed.${warning ? ` ${warning}` : ''}`;
      return { image: copyFrame(reference), reference, stats, warning };
    }
    const length = width * height;
    const sums = new Float32Array(length * 3);
    const weights = new Uint8Array(length);
    for (const { candidate, dx, dy } of aligned) {
      const data = candidate.frame.data;
      for (let y = 0; y < height; y++) {
        const sy = y + dy;
        if (sy < 0 || sy > height - 1) continue;
        const y0 = Math.floor(sy);
        const fy = sy - y0;
        const down = y0 + 1 < height ? width * 4 : 0;
        for (let x = 0; x < width; x++) {
          const sx = x + dx;
          if (sx < 0 || sx > width - 1) continue;
          const x0 = Math.floor(sx);
          const fx = sx - x0;
          const p = (y0 * width + x0) * 4;
          const right = x0 + 1 < width ? 4 : 0;
          const i = y * width + x;
          for (let c = 0; c < 3; c++) {
            sums[i * 3 + c] += (linear[data[p + c]] * (1 - fx) + linear[data[p + right + c]] * fx) * (1 - fy) +
              (linear[data[p + down + c]] * (1 - fx) + linear[data[p + down + right + c]] * fx) * fy;
          }
          weights[i]++;
        }
      }
    }
    const output = new Uint8ClampedArray(length * 4);
    for (let i = 0; i < length; i++) {
      for (let c = 0; c < 3; c++) output[i * 4 + c] = encode(sums[i * 3 + c] / weights[i]);
      output[i * 4 + 3] = 255;
    }
    return { image: { width, height, data: output }, reference, stats, warning };
  }
}
