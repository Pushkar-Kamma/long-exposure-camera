function randomSource(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function normalSource(random) {
  let spare = null;
  return () => {
    if (spare !== null) { const value = spare; spare = null; return value; }
    const radius = Math.sqrt(-2 * Math.log(Math.max(1e-12, random())));
    const angle = 2 * Math.PI * random();
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
}

function encode(value) {
  const bounded = Math.max(0, Math.min(1, value));
  return Math.round(255 * (bounded <= 0.0031308 ? 12.92 * bounded : 1.055 * bounded ** (1 / 2.4) - 0.055));
}

function decode(value) {
  const encoded = value / 255;
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
}

function blur(input, width, height) {
  let current = input;
  for (let pass = 0; pass < 5; pass++) {
    const horizontal = new Float32Array(input.length);
    const output = new Float32Array(input.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = (y * width + x) * 3;
        const left = x ? p - 3 : p;
        const right = x + 1 < width ? p + 3 : p;
        for (let c = 0; c < 3; c++) horizontal[p + c] = (current[left + c] + 2 * current[p + c] + current[right + c]) / 4;
      }
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = (y * width + x) * 3;
        const up = y ? p - width * 3 : p;
        const down = y + 1 < height ? p + width * 3 : p;
        for (let c = 0; c < 3; c++) output[p + c] = (horizontal[up + c] + 2 * horizontal[p + c] + horizontal[down + c]) / 4;
      }
    }
    current = output;
  }
  return current;
}

/**
 * An original procedural test target, NOT a real Moon map or an engine input prior.
 * Frames are generated lazily and are independently reproducible on each iteration.
 * shiftX/shiftY locate the translated truth; kind identifies intentionally bad examples.
 */
export function createMoonSimulation({ count = 48, seed = 2026, width = 256, height = 256 } = {}) {
  if (!Number.isInteger(count) || count < 1 || !Number.isFinite(seed) ||
      !Number.isInteger(width) || !Number.isInteger(height) ||
      width < 32 || height < 32 || width > 512 || height > 512) {
    throw new RangeError('Simulation needs a positive integer count, finite seed, and dimensions between 32 and 512 pixels.');
  }
  const radius = Math.min(width, height) * 0.3;
  const centerX = (width - 1) / 2;
  const centerY = (height - 1) / 2;
  const random = randomSource(seed);
  const spots = Array.from({ length: 18 }, () => ({
    x: (random() - 0.5) * 1.5,
    y: (random() - 0.5) * 1.5,
    radius: 0.035 + random() * 0.09,
    depth: 0.025 + random() * 0.045
  }));
  const truthData = new Uint8ClampedArray(width * height * 4);
  const clean = new Float32Array(width * height * 3);
  const sky = decode(18);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let surface = 0;
      for (const oy of [-0.25, 0.25]) {
        for (const ox of [-0.25, 0.25]) {
          const u = (x + ox - centerX) / radius;
          const v = (y + oy - centerY) / radius;
          const r2 = u * u + v * v;
          if (r2 >= 1) { surface += sky / 4; continue; }
          let texture = 0.31 + 0.027 * Math.sin(u * 31 + v * 9) * Math.cos(v * 27 - u * 6) +
            0.022 * Math.cos(u * 15 - v * 19) + 0.012 * Math.sin(u * 61 + v * 38);
          for (const spot of spots) {
            const distance = ((u - spot.x) ** 2 + (v - spot.y) ** 2) / (spot.radius ** 2);
            if (distance < 12) texture += spot.depth * (0.45 * Math.exp(-((Math.sqrt(distance) - 1.5) ** 2) * 4) - Math.exp(-distance * 1.5));
          }
          surface += texture * (0.76 + 0.24 * Math.sqrt(1 - r2)) * (0.88 + 0.12 * u) / 4;
        }
      }
      const i = y * width + x;
      truthData[i * 4] = encode(surface * 1.025);
      truthData[i * 4 + 1] = encode(surface);
      truthData[i * 4 + 2] = encode(surface * 0.97);
      truthData[i * 4 + 3] = 255;
      for (let c = 0; c < 3; c++) clean[i * 3 + c] = decode(truthData[i * 4 + c]);
    }
  }
  const frames = {
    *[Symbol.iterator]() {
      const noise = normalSource(randomSource(seed ^ 0x31415926));
      for (let index = 0; index < count; index++) {
        const shiftX = index ? ((index * 7) % 13 - 6) * 0.47 : 0;
        const shiftY = index ? ((index * 11) % 17 - 8) * 0.37 : 0;
        const kind = index % 13 === 10 ? 'clipped' : index % 11 === 6 ? 'blurred' : 'normal';
        let pixels = new Float32Array(clean.length);
        for (let y = 0; y < height; y++) {
          const sy = Math.max(0, Math.min(height - 1, y - shiftY));
          const y0 = Math.floor(sy);
          const fy = sy - y0;
          const down = y0 + 1 < height ? width * 3 : 0;
          for (let x = 0; x < width; x++) {
            const sx = Math.max(0, Math.min(width - 1, x - shiftX));
            const x0 = Math.floor(sx);
            const fx = sx - x0;
            const p = (y0 * width + x0) * 3;
            const right = x0 + 1 < width ? 3 : 0;
            for (let c = 0; c < 3; c++) {
              pixels[(y * width + x) * 3 + c] = (clean[p + c] * (1 - fx) + clean[p + right + c] * fx) * (1 - fy) +
                (clean[p + down + c] * (1 - fx) + clean[p + down + right + c] * fx) * fy;
            }
          }
        }
        if (kind === 'blurred') pixels = blur(pixels, width, height);
        const data = new Uint8ClampedArray(width * height * 4);
        for (let i = 0; i < width * height; i++) {
          for (let c = 0; c < 3; c++) {
            const value = pixels[i * 3 + c] * (kind === 'clipped' ? 6 : 1);
            // Approximate shot noise plus read noise, added before sRGB encoding.
            data[i * 4 + c] = encode(value + noise() * Math.sqrt(value / 550 + 0.000002));
          }
          data[i * 4 + 3] = 255;
        }
        yield { width, height, data, index, shiftX, shiftY, kind };
      }
    }
  };
  return { width, height, truth: { width, height, data: truthData }, frames };
}
