import { smoothImage, registrationMap, correlation, register } from './alignment.js';

const ORIGIN = { centerX: 0, centerY: 0 };
const PATCH_RADIUS = 6;
const CONSENSUS_RADIUS = 0.45;

function separated(patches, width, height) {
  if (patches.length < 6) return false;
  const xs = patches.map(patch => patch.x);
  const ys = patches.map(patch => patch.y);
  const spanX = (Math.max(...xs) - Math.min(...xs)) / width;
  const spanY = (Math.max(...ys) - Math.min(...ys)) / height;
  // A moving water/traffic band may remove a whole grid row or column. Still
  // require broad two-dimensional coverage, not one line or a compact subject.
  return spanX >= 0.3 && spanY >= 0.3 && Math.max(spanX, spanY) >= 0.45 &&
    new Set(patches.map(patch => patch.column)).size >= 2 &&
    new Set(patches.map(patch => patch.row)).size >= 2;
}

function makePatches(smooth, map, width, height) {
  const columns = width >= height ? 4 : 3;
  const rows = width >= height ? 3 : 4;
  const marginX = PATCH_RADIUS + Math.ceil(width * 0.05) + 3;
  const marginY = PATCH_RADIUS + Math.ceil(height * 0.05) + 3;
  const patches = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const x = Math.round(marginX + column * (width - 1 - 2 * marginX) / (columns - 1));
      const y = Math.round(marginY + row * (height - 1 - 2 * marginY) / (rows - 1));
      const points = [];
      let sum = 0;
      let sumSquares = 0;
      let brightness = 0;
      let xx = 0;
      let xy = 0;
      let yy = 0;
      for (let v = y - PATCH_RADIUS; v <= y + PATCH_RADIUS; v += 2) {
        for (let u = x - PATCH_RADIUS; u <= x + PATCH_RADIUS; u += 2) {
          const i = v * width + u;
          const value = map[i];
          const gx = (smooth[i + 1] - smooth[i - 1]) / 2;
          const gy = (smooth[i + width] - smooth[i - width]) / 2;
          points.push(u, v, value);
          sum += value;
          sumSquares += value * value;
          brightness += smooth[i];
          xx += gx * gx;
          xy += gx * gy;
          yy += gy * gy;
        }
      }
      const count = points.length / 3;
      const variance = sumSquares - sum * sum / count;
      // A single edge/light or parallel stripes cannot constrain both axes.
      const weakerGradient = (xx + yy - Math.hypot(xx - yy, 2 * xy)) / (2 * count);
      if (brightness / count < 12 || variance / count < 5 || weakerGradient < 1) continue;
      const template = { points: Float32Array.from(points), count, sum, variance };
      let ambiguous = false;
      // Check beyond the allowed drift: a whole texture cycle plus a small jump
      // otherwise looks like a confident nearby match. Reference-only work.
      for (let dy = -Math.ceil(height * 0.25); dy <= Math.ceil(height * 0.25) && !ambiguous; dy++) {
        for (let dx = -Math.ceil(width * 0.25); dx <= Math.ceil(width * 0.25); dx++) {
          if (dx * dx + dy * dy < 9) continue;
          if (correlation(template, map, width, height, dx, dy) > 0.9) {
            ambiguous = true;
            break;
          }
        }
      }
      if (!ambiguous) patches.push({ x, y, row, column, template });
    }
  }
  return patches;
}

function median(values) {
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function matchPatches(reference, map, centerX, centerY) {
  const { width, height, patches } = reference;
  const matches = [];
  for (const patch of patches) {
    const shift = register(patch.template, map, width, height, ORIGIN, { centerX, centerY });
    if (shift && shift.correlation >= 0.9) matches.push({ ...patch, ...shift });
  }
  let consensus = [];
  for (const seed of matches) {
    const nearby = matches.filter(match => Math.hypot(match.dx - seed.dx, match.dy - seed.dy) <= CONSENSUS_RADIUS);
    if (nearby.length > consensus.length) consensus = nearby;
  }
  if (consensus.length < Math.max(6, Math.ceil(patches.length * 0.65)) ||
      !separated(consensus, width, height)) return null;
  const dx = median(consensus.map(match => match.dx));
  const dy = median(consensus.map(match => match.dy));
  // Every accepted sample is measured against the original reference, never
  // added to an optical-flow trajectory. Minority moving subjects are outliers.
  if (Math.abs(dx) > Math.min(8, width * 0.05) || Math.abs(dy) > Math.min(8, height * 0.05)) return null;
  const confidence = consensus.reduce((sum, match) => sum + match.correlation, 0) / patches.length;
  return { dx, dy, confidence: Math.min(1, confidence), matches: consensus.length };
}

/**
 * Optional small-translation estimator for opaque, <=160px camera previews.
 * dx/dy locate an ORIGINAL reference pixel in the CURRENT image; sample at
 * reference + offset. Rejected offsets must not be used to stack the frame.
 * Create a new tracker per shot. Dimensions never reset an established anchor.
 * Retains only <=12 sparse reference templates and the last accepted offset.
 *
 * Image-only registration cannot distinguish camera movement from an entire
 * moving scene. Clouds/water/trails need enough separated static background;
 * this deliberately refuses ambiguous texture or inconsistent translation.
 * No rotation, affine warping, deblurring, or invented detail is attempted.
 */
export class CameraMotionTracker {
  constructor() {
    this.reference = null;
    this.dx = 0;
    this.dy = 0;
  }

  update(frame) {
    const reject = reason => ({
      accepted: false, dx: this.dx, dy: this.dy, confidence: 0, matches: 0, reason, moved: false
    });
    if (!frame || !Number.isInteger(frame.width) || !Number.isInteger(frame.height) ||
        frame.width < 48 || frame.height < 48 || frame.width > 160 || frame.height > 160 ||
        !(frame.data instanceof Uint8ClampedArray) || frame.data.length !== frame.width * frame.height * 4) {
      return reject('Expected a valid 48-160 pixel RGBA analysis image with Uint8ClampedArray data.');
    }
    const { width, height, data } = frame;
    if (this.reference && (width !== this.reference.width || height !== this.reference.height)) {
      return reject('Frame dimensions changed; start a new shot to establish a new reference.');
    }
    const gray = new Float32Array(width * height);
    let brightness = 0;
    for (let i = 0; i < gray.length; i++) {
      const p = i * 4;
      if (data[p + 3] !== 255) return reject('Use an opaque camera analysis image.');
      gray[i] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
      brightness += gray[i];
    }
    if (brightness / gray.length < 12) return reject('Scene is too dark to measure camera shake reliably.');
    const smooth = smoothImage(gray, width, height);
    const map = registrationMap(smooth, width, height);
    if (!this.reference) {
      const patches = makePatches(smooth, map, width, height);
      if (!separated(patches, width, height)) {
        return reject('Not enough separated, unambiguous background texture; hold steady or disable shake correction.');
      }
      this.reference = { width, height, patches };
      return { accepted: true, dx: 0, dy: 0, confidence: 1, matches: patches.length, reason: 'Reference established.', moved: false };
    }
    let result = matchPatches(this.reference, map, this.dx, this.dy);
    // A rejected jump must not poison the anchor. Also search its original view
    // when the last good offset is too far away for the local +/-3 pixel search.
    if (!result && (Math.abs(this.dx) > 0.5 || Math.abs(this.dy) > 0.5)) {
      result = matchPatches(this.reference, map, 0, 0);
    }
    if (!result) {
      return reject('No reliable background consensus: low texture, moving subjects, rotation, or excessive camera movement. Return to the original view.');
    }
    this.dx = result.dx;
    this.dy = result.dy;
    return {
      accepted: true, ...result, reason: 'Background translation matched.',
      moved: Math.hypot(result.dx, result.dy) > 0.15
    };
  }
}
