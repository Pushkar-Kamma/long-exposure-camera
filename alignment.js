export function smoothImage(input, width, height) {
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

export function registrationMap(smooth, width, height) {
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

export function correlation(template, map, width, height, dx, dy, parity = -1) {
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

export function hasRegistrationTexture(template) {
  return template.count >= 32 && template.variance >= template.count;
}

export function register(template, map, width, height, referenceAnalysis, analysis) {
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
