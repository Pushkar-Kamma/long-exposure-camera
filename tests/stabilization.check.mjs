import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

async function checkRenderer(page) {
  return page.evaluate(async () => {
    const { FrameStacker } = await import('./stacker.js');
    const canvas = document.createElement('canvas');
    const stacker = new FrameStacker(canvas);
    const gl = stacker.gl;
    const check = (condition, label) => { if (!condition) throw new Error(label); };
    const linear = value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    const encode = value => 255 * (value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055);
    let seed = 918273;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const frame = (width, height, pixel) => {
      const source = document.createElement('canvas');
      source.width = width;
      source.height = height;
      const image = source.getContext('2d').createImageData(width, height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) image.data.set([...pixel(x, y), 255], (y * width + x) * 4);
      }
      source.getContext('2d').putImageData(image, 0, 0);
      return { source, data: image.data, width, height };
    };
    const read = (floating = false) => {
      if (floating) gl.bindFramebuffer(gl.FRAMEBUFFER, stacker.targets[stacker.current].framebuffer);
      else stacker.render();
      const result = floating ? new Float32Array(canvas.width * canvas.height * 4) : new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, floating ? gl.FLOAT : gl.UNSIGNED_BYTE, result);
      check(gl.getError() === gl.NO_ERROR, 'Shifted renderer must not produce WebGL errors');
      const topDown = result.slice();
      const stride = canvas.width * 4;
      for (let y = 0; y < canvas.height; y++) topDown.set(result.subarray((canvas.height - 1 - y) * stride, (canvas.height - y) * stride), y * stride);
      return topDown;
    };
    const compare = (actual, expected, label, tolerance = 2) => {
      let worst = 0;
      let index = 0;
      for (let i = 0; i < actual.length; i++) {
        if (Math.abs(actual[i] - expected[i]) > worst) { worst = Math.abs(actual[i] - expected[i]); index = i; }
      }
      check(worst <= tolerance, `${label}: maximum error ${worst} at channel ${index}: ${actual[index]} vs ${expected[index]}`);
    };
    const oracle = (frames, offsets, mode) => {
      const { width, height } = frames[0];
      const pixels = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const sum = [0, 0, 0];
          let count = 0;
          frames.forEach((input, i) => {
            const sx = x + offsets[i].x;
            const sy = y + offsets[i].y;
            if (sx + 0.5 < 0 || sy + 0.5 < 0 || sx + 0.5 >= width || sy + 0.5 >= height) return;
            const left = Math.floor(sx);
            const top = Math.floor(sy);
            const fx = sx - left;
            const fy = sy - top;
            const at = (u, v, c) => linear(input.data[(Math.max(0, Math.min(height - 1, v)) * width + Math.max(0, Math.min(width - 1, u))) * 4 + c] / 255);
            for (let c = 0; c < 3; c++) {
              const incoming = (at(left, top, c) * (1 - fx) + at(left + 1, top, c) * fx) * (1 - fy)
                + (at(left, top + 1, c) * (1 - fx) + at(left + 1, top + 1, c) * fx) * fy;
              sum[c] = mode === 'trails' ? Math.max(sum[c], incoming) : sum[c] + incoming;
            }
            count++;
          });
          pixels.set([...sum.map(value => encode(value / (mode === 'average' ? Math.max(count, 1) : 1))), 255], (y * width + x) * 4);
        }
      }
      return pixels;
    };
    const stack = (frames, offsets, mode = 'average') => {
      stacker.reset(frames[0].width, frames[0].height, mode);
      frames.forEach((input, i) => stacker.add(input.source, offsets?.[i]));
      return read();
    };
    try {
      const texture = frame(19, 13, () => [random(), random(), random()].map(value => Math.round(25 + value * 180)));
      const second = frame(19, 13, () => [random(), random(), random()].map(value => Math.round(value * 255)));
      for (const mode of ['average', 'trails']) {
        const implicit = stack([texture, second], undefined, mode);
        compare(stack([texture, second], [{ x: 0, y: 0 }, { x: 0, y: 0 }], mode), implicit, `${mode} explicit zero preserves default`, 0);
        compare(implicit, oracle([texture, second], [{ x: 0, y: 0 }, { x: 0, y: 0 }], mode), `${mode} original unshifted result`);
        for (const offset of [{ x: 3, y: 0 }, { x: -3, y: 0 }, { x: 0, y: 2 }, { x: 0, y: -2 }, { x: 2, y: -3 },
          { x: 0.25, y: 0 }, { x: -0.75, y: 0 }, { x: 0, y: 0.25 }, { x: 0, y: -0.75 }, { x: 1.25, y: -1.75 }, { x: -1.25, y: 1.75 }]) {
          const offsets = [{ x: 0, y: 0 }, offset];
          compare(stack([texture, second], offsets, mode), oracle([texture, second], offsets, mode), `${mode} source-pixel shift ${JSON.stringify(offset)}`);
        }
      }
      for (const axis of ['x', 'y']) {
        const edge = frame(2, 2, (x, y) => Array(3).fill((axis === 'x' ? x : y) * 255));
        const pixels = stack([edge], [{ [axis]: 0.5 }]);
        check(Math.abs(pixels[0] - 188) <= 1, `${axis} half-pixel interpolation is linear-light 188, not sRGB 128: ${pixels[0]}`);
      }
      const white = frame(5, 4, () => [255, 255, 255]);
      const black = frame(5, 4, () => [0, 0, 0]);
      const weighted = stack([white, black], [{ x: 0, y: 0 }, { x: 2, y: -1 }]);
      const sums = read(true);
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 5; x++) {
          const observed = x < 3 && y > 0;
          const i = (y * 5 + x) * 4;
          check(sums[i + 3] === (observed ? 2 : 1), `Per-pixel observation count at ${x},${y}`);
          check(Math.abs(weighted[i] - (observed ? 188 : 255)) <= 1, `Shifted border is not darkened at ${x},${y}`);
        }
      }
      stacker.reset(19, 13, 'average');
      stacker.add(texture.source);
      for (const offset of [{ x: NaN }, { y: Infinity }, { x: -Infinity }, { x: '1' }, { x: 19 }, { x: -19 }, { y: 13 }, { y: -13 }, { x: 1000, y: 0 }]) {
        let message = '';
        try { stacker.add(texture.source, offset); } catch (error) { message = error.message; }
        check(/alignment.*outside.*image/i.test(message), `Invalid offset rejected clearly: ${JSON.stringify(offset)}`);
        check(stacker.frames === 1, 'Rejected offset does not mutate frame count');
      }
      compare(read(), texture.data, 'Rejected offsets leave existing stack untouched');

      const width = 96;
      const height = 64;
      const truth = frame(width, height, () => {
        const value = Math.round(25 + random() * 120);
        return [value, value + 8, value + 16];
      });
      const pixel = (x, y) => [...truth.data.slice((y * width + x) * 4, (y * width + x) * 4 + 3)];
      const offsets = Array.from({ length: 18 }, (_, index) => index ? { x: Math.floor(random() * 9) - 4, y: Math.floor(random() * 9) - 4 } : { x: 0, y: 0 });
      const idealFrames = offsets.map((_, index) => frame(width, height, (x, y) => Math.abs(x - (17 + index * 3)) <= 1 && Math.abs(y - 35) <= 1 ? [255, 245, 230] : pixel(x, y)));
      const jittered = idealFrames.map((input, index) => frame(width, height, (x, y) => {
        const sx = Math.max(0, Math.min(width - 1, x - offsets[index].x));
        const sy = Math.max(0, Math.min(height - 1, y - offsets[index].y));
        return [...input.data.slice((sy * width + sx) * 4, (sy * width + sx) * 4 + 3)];
      }));
      const errors = {};
      for (const mode of ['average', 'trails']) {
        const aligned = stack(jittered, offsets, mode);
        const unaligned = stack(jittered, undefined, mode);
        const ideal = stack(idealFrames, undefined, mode);
        let corrected = 0;
        let blurred = 0;
        let trajectoryError = 0;
        let samples = 0;
        for (let y = 6; y < height - 6; y++) {
          for (let x = 6; x < width - 6; x++) {
            for (let c = 0; c < 3; c++) {
              const i = (y * width + x) * 4 + c;
              trajectoryError = Math.max(trajectoryError, Math.abs(aligned[i] - ideal[i]));
              if (y >= 29 && y <= 41) continue;
              corrected += Math.abs(aligned[i] - truth.data[i]);
              blurred += Math.abs(unaligned[i] - truth.data[i]);
              samples++;
            }
          }
        }
        errors[mode] = { alignedMAE: corrected / samples, unalignedMAE: blurred / samples, trajectoryMaxError: trajectoryError };
        check(corrected < blurred * 0.15, `${mode} alignment materially improves known static truth: ${JSON.stringify(errors[mode])}`);
        check(trajectoryError <= 2, `${mode} preserves independently moving foreground, rather than freezing it`);
        if (mode === 'trails') {
          const bright = [];
          for (let x = 8; x < width - 8; x++) if (aligned[(35 * width + x) * 4] > 245) bright.push(x);
          check(bright.length >= 45 && bright.at(-1) - bright[0] >= 50, 'Aligned max trails retains the complete moving-light trajectory');
        }
      }
      return errors;
    } finally {
      stacker.dispose();
    }
  });
}

async function installSyntheticCamera(context) {
  await context.addInitScript(() => {
    const fixture = globalThis.stabilizationFixture = { kind: 'mixed', index: 0, streams: [], trackers: [], adds: [], analysis: [] };
    const texture = document.createElement('canvas');
    texture.width = 160;
    texture.height = 90;
    const pixels = texture.getContext('2d').createImageData(160, 90);
    let seed = 7341;
    for (let i = 0; i < pixels.data.length; i += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const value = 35 + Math.floor(seed / 2 ** 32 * 150);
      pixels.data.set([value, value, value, 255], i);
    }
    texture.getContext('2d').putImageData(pixels, 0, 0);
    const scene = document.createElement('canvas');
    scene.width = 1280;
    scene.height = 720;
    const ctx = scene.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const shifts = [[0, 0], [8, -8], [-8, 8], [0, -8], [8, 8], [-8, 0], [8, 0], [0, 8]];
    fixture.draw = () => {
      const index = fixture.index++;
      ctx.fillStyle = '#777';
      ctx.fillRect(0, 0, 1280, 720);
      const flat = fixture.kind === 'flat' || (fixture.kind === 'mixed' && index % 7 === 6);
      if (!flat) {
        const [x, y] = shifts[index % shifts.length];
        ctx.drawImage(texture, x, y, 1280, 720);
        ctx.fillStyle = '#fff';
        ctx.fillRect(200 + (index % 18) * 40 + x, 400 + y, 24, 24);
      }
      for (const stream of fixture.streams) {
        const track = stream.getVideoTracks()[0];
        if (track.readyState === 'live') track.requestFrame();
      }
    };
    navigator.mediaDevices.getUserMedia = async constraints => {
      if (constraints.audio !== false) throw new Error('Synthetic camera must not request audio');
      fixture.draw();
      const stream = scene.captureStream(0);
      fixture.streams.push(stream);
      fixture.draw();
      return stream;
    };
    navigator.mediaDevices.enumerateDevices = async () => [];
    setInterval(fixture.draw, 90);
  });
}

async function instrumentCapture(page) {
  await page.evaluate(async () => {
    const { CameraMotionTracker } = await import('./motion-core.js');
    const { FrameStacker } = await import('./stacker.js');
    const fixture = globalThis.stabilizationFixture;
    const update = CameraMotionTracker.prototype.update;
    CameraMotionTracker.prototype.update = function (frame) {
      const result = update.call(this, frame);
      fixture.trackers.push({ ...result, width: frame.width, height: frame.height });
      fixture.lastAnalysis = { data: [...frame.data], width: frame.width, height: frame.height };
      if (fixture.kind === 'single' && result.accepted) {
        fixture.kind = 'flat';
        fixture.draw();
      }
      return result;
    };
    const add = FrameStacker.prototype.add;
    FrameStacker.prototype.add = function (source, offset) {
      const result = add.call(this, source, offset);
      if (this.canvas.id === 'output') {
        fixture.adds.push({ offset: offset || null, width: source.videoWidth, height: source.videoHeight });
        if (offset) fixture.analysis.push(fixture.lastAnalysis);
      }
      return result;
    };
  });
}

export async function runStabilizationChecks({ browser, origin, watchErrors }) {
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, permissions: ['camera'] });
  await installSyntheticCamera(context);
  const page = await context.newPage();
  watchErrors(page);
  const settings = async () => {
    if (!await page.locator('#settingsPanel').evaluate(panel => panel.open)) await page.click('#settingsToggle');
  };
  const ready = () => page.waitForFunction(() => document.body.dataset.phase === 'ready');
  const count = () => page.evaluate(async () => (await (await import('./gallery.js')).listPhotos(100)).total);
  const latest = () => page.evaluate(async () => {
    const { listPhotos, getPhoto } = await import('./gallery.js');
    const { entries, total } = await listPhotos(100);
    const photo = entries.length ? await getPhoto(entries[0].id) : null;
    return { total, entry: entries[0] && { ...entries[0], thumbnail: undefined }, photo: photo && { ...photo, blob: { size: photo.blob.size, type: photo.blob.type } } };
  });
  const saved = async () => {
    await page.locator('#photoStorage[data-state="saved"]').waitFor({ timeout: 30000 });
    assert.equal(await page.locator('#error').isVisible(), false);
    assert.equal(await page.locator('#result').isVisible(), true);
  };
  const fixture = () => page.evaluate(() => ({
    trackers: stabilizationFixture.trackers, adds: stabilizationFixture.adds,
    liveTracks: stabilizationFixture.streams.filter(stream => stream.getVideoTracks()[0].readyState === 'live').length
  }));
  const reset = kind => page.evaluate(kind => {
    Object.assign(stabilizationFixture, { kind, trackers: [], adds: [], analysis: [] });
    stabilizationFixture.draw();
  }, kind);
  const locked = async () => {
    assert.equal(await page.locator('#stabilize').isDisabled(), true);
    assert.equal(await page.locator('#settingsToggle').isDisabled(), true);
    assert.equal(await page.locator('#moonOpen').isDisabled(), true);
    assert.equal(await page.locator('#settings input, #settings select, #settings button').evaluateAll(controls => controls.every(control => control.disabled)), true);
  };
  try {
    await page.goto(origin);
    const numerical = await checkRenderer(page);
    console.log('PASS stabilization WebGL: unchanged identity, signed integer/subpixel XY, linear interpolation, border weights, offset rejection, moving trails', numerical);
    assert.equal(await page.locator('#settingsPanel').evaluate(panel => panel.open), false);
    assert.equal(await page.locator('#stabilize').isChecked(), false);
    assert.equal(await page.locator('#stabilize').getAttribute('role'), 'switch');
    assert.equal(await page.locator('#stabilize').isVisible(), false);
    await page.evaluate(async () => {
      const { PREFERENCES_KEY } = await import('./preferences.js');
      localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ duration: 2, mode: 'average', delay: '0', quality: '720' }));
    });
    await page.reload();
    assert.equal(await page.locator('#stabilize').isChecked(), false, 'Legacy preferences without stabilize remain valid and off');
    assert.equal(await page.locator('#duration').inputValue(), '2');
    assert.doesNotMatch(await page.locator('#preferencesStatus').textContent(), /could not be loaded/);
    await settings();
    await page.check('#stabilize');
    await page.reload();
    assert.equal(await page.locator('#stabilize').isChecked(), true, 'Opt-in persists after reload');
    assert.equal(await page.locator('#settingsPanel').evaluate(panel => panel.open), false);
    await instrumentCapture(page);
    await page.click('#enable');
    await ready();
    assert.match(await page.locator('#resolution').textContent(), /1280 x 720/);
    await reset('mixed');
    await page.click('#shutter');
    await page.waitForFunction(() => document.body.dataset.phase === 'capturing');
    await locked();
    assert.equal(await page.locator('#stabilizationStatus').isVisible(), true);
    await page.waitForFunction(() => /used.*skipped/.test(document.querySelector('#frames').textContent));
    await saved();
    const average = await latest();
    const captured = await fixture();
    assert.equal(average.photo.stabilized, true);
    assert.equal(average.photo.mode, 'average');
    assert.equal(average.photo.outcome, 'complete');
    assert.equal(average.photo.requested, 2);
    assert.ok(average.photo.actual >= 1.8 && average.photo.actual < 4, 'Source frames, including rejections, time the requested exposure');
    assert.ok(average.photo.framesUsed >= 4);
    assert.ok(average.photo.framesSkipped >= 1, 'Low-texture interruptions are skipped, not accumulated');
    assert.equal(average.photo.framesSampled, captured.trackers.length);
    assert.equal(average.photo.framesUsed, captured.adds.length);
    assert.equal(average.photo.framesUsed + average.photo.framesSkipped, average.photo.framesSampled);
    assert.ok(average.photo.correctedFrames > 0);
    assert.ok(average.photo.maxShift >= 6 && average.photo.maxShift < 40, `Shift metadata uses camera pixels: ${average.photo.maxShift}`);
    assert.deepEqual([average.photo.width, average.photo.height], [1280, 720]);
    assert.ok(average.photo.blob.size > 1000);
    assert.equal(average.photo.blob.type, 'image/jpeg');
    assert.equal(captured.liveTracks, 0, 'Completed capture stops generated camera tracks');
    assert.equal(await page.locator('#frames').textContent(), `${average.photo.framesUsed} used / ${average.photo.framesSkipped} skipped`);
    assert.match(await page.locator('#stabilizationStatus').textContent(), /frames used.*shifted.*skipped/);
    const accepted = captured.trackers.filter(record => record.accepted);
    assert.deepEqual([accepted[0].dx, accepted[0].dy], [0, 0]);
    captured.trackers.forEach(record => assert.deepEqual([record.width, record.height], [160, 90]));
    accepted.forEach((record, index) => {
      const { offset, width, height } = captured.adds[index];
      assert.deepEqual([width, height], [1280, 720]);
      assert.ok(Math.abs(offset.x - record.dx * 8) < 1e-8, 'Analysis-to-camera X scale/sign');
      assert.ok(Math.abs(offset.y - record.dy * 8) < 1e-8, 'Analysis-to-camera Y scale/sign');
    });
    const uiError = await page.evaluate(() => {
      const frames = stabilizationFixture.analysis;
      const { width, height } = frames[0];
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(document.querySelector('#output'), 0, 0, width, height);
      const aligned = canvas.getContext('2d').getImageData(0, 0, width, height).data;
      const linear = value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      const encode = value => 255 * (value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055);
      let corrected = 0;
      let blurred = 0;
      let count = 0;
      for (let y = 8; y < height - 8; y++) {
        if (y >= 45 && y <= 58) continue;
        for (let x = 8; x < width - 8; x++) {
          const i = (y * width + x) * 4;
          const truth = frames[0].data[i];
          const ordinary = encode(frames.reduce((sum, frame) => sum + linear(frame.data[i] / 255), 0) / frames.length);
          corrected += Math.abs(aligned[i] - truth);
          blurred += Math.abs(ordinary - truth);
          count++;
        }
      }
      return { alignedMAE: corrected / count, unalignedMAE: blurred / count };
    });
    assert.ok(uiError.alignedMAE < uiError.unalignedMAE * 0.55, `Actual 720p camera→tracker→GPU pipeline improves the stationary background: ${JSON.stringify(uiError)}`);
    for (const key of ['stabilized', 'framesUsed', 'framesSampled', 'framesSkipped', 'correctedFrames', 'maxShift']) assert.equal(average.entry[key], average.photo[key], `Gallery metadata retains ${key}`);
    console.log('PASS stabilization 720p UI: real tracker + source-pixel GPU corrections, rejected-frame timing, locked settings, persisted metadata', uiError);

    await page.click('#again');
    await ready();
    await settings();
    await page.check('input[value="trails"]');
    await page.fill('#duration', '1');
    await reset('textured');
    await page.click('#shutter');
    await saved();
    const trails = await latest();
    assert.equal(trails.photo.mode, 'trails');
    assert.equal(trails.photo.stabilized, true);
    assert.ok(trails.photo.framesUsed > 1 && trails.photo.correctedFrames > 0);

    await page.click('#again');
    await ready();
    await settings();
    await page.uncheck('#stabilize');
    await reset('textured');
    await page.click('#shutter');
    await saved();
    const ordinary = await latest();
    const ordinaryCalls = await fixture();
    assert.equal(ordinary.photo.stabilized, false);
    assert.equal(ordinary.photo.framesSkipped, 0);
    assert.equal(ordinary.photo.correctedFrames, 0);
    assert.equal(ordinary.photo.maxShift, 0);
    assert.equal(ordinary.photo.framesSampled, ordinary.photo.framesUsed);
    assert.equal(ordinaryCalls.trackers.length, 0, 'Switching off bypasses motion tracking entirely');
    assert.ok(ordinaryCalls.adds.length > 1 && ordinaryCalls.adds.every(record => record.offset === null));
    assert.match(await page.locator('#frames').textContent(), /^\d+ frames$/);
    assert.equal(await page.locator('#stabilizationStatus').isVisible(), false);
    await page.reload();
    assert.equal(await page.locator('#stabilize').isChecked(), false, 'Explicit off persists');
    assert.equal(await count(), 3, 'Generated gallery results persist after reload');
    await instrumentCapture(page);
    await settings();
    await page.check('#stabilize');
    await page.check('input[value="average"]');
    await reset('flat');
    await page.click('#enable');
    await ready();
    await page.click('#shutter');
    await page.waitForFunction(() => stabilizationFixture.trackers.some(record => !record.accepted));
    assert.match(await page.locator('#stabilizationStatus').textContent(), /skipped|texture|background/i);
    await page.locator('#error').waitFor({ state: 'visible' });
    assert.match(await page.locator('#error').textContent(), /no frames could be aligned/i);
    assert.match(await page.locator('#error').textContent(), /texture|background|detail|contrast/i);
    assert.equal(await page.locator('#badge').textContent(), 'NO PHOTO');
    assert.equal(await page.locator('#result').isVisible(), false);
    assert.equal(await page.locator('#download').getAttribute('href'), null);
    assert.equal(await count(), 3, 'All-flat sequence must not fabricate a saved result');
    assert.equal((await fixture()).adds.length, 0);
    assert.equal((await fixture()).liveTracks, 0);
    assert.equal(await page.locator('#enable').isEnabled(), true, 'Camera can restart after no usable frames');
    assert.equal(await page.locator('#stabilize').isEnabled(), true);

    await reset('single');
    await page.click('#enable');
    await ready();
    await page.click('#shutter');
    await saved();
    const single = await latest();
    assert.equal(single.photo.framesUsed, 1);
    assert.ok(single.photo.framesSkipped > 0);
    assert.equal(single.photo.outcome, 'incomplete');
    assert.match(await page.locator('#badge').textContent(), /PARTIAL/);
    assert.match(await page.locator('#notice').textContent(), /single frame, not.*long-exposure/i);
    assert.equal(single.photo.stabilized, true);

    await page.click('#again');
    await ready();
    await settings();
    await page.fill('#duration', '3');
    await page.selectOption('#delay', '3');
    const beforeCancel = await count();
    await page.click('#shutter');
    await page.waitForFunction(() => document.body.dataset.phase === 'countdown');
    await locked();
    await page.click('#cancel');
    await ready();
    assert.equal(await page.locator('#stabilize').isEnabled(), true);
    await settings();
    await page.selectOption('#delay', '0');
    await reset('textured');
    await page.click('#shutter');
    await page.waitForFunction(() => stabilizationFixture.adds.length >= 2);
    await locked();
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await page.evaluate(() => {
      globalThis.stabilizationDocumentToken = crypto.randomUUID();
      navigator.serviceWorker.dispatchEvent(new Event('controllerchange'));
      navigator.serviceWorker.dispatchEvent(new Event('controllerchange'));
    });
    const documentToken = await page.evaluate(() => stabilizationDocumentToken);
    await page.locator('#updateBanner').waitFor({ state: 'visible' });
    await page.click('#applyUpdate');
    assert.match(await page.locator('#notice').textContent(), /Finish or cancel.*save before updating/);
    assert.equal(await page.evaluate(() => stabilizationDocumentToken), documentToken);
    assert.equal(await page.locator('body').getAttribute('data-phase'), 'capturing');
    assert.equal((await fixture()).liveTracks, 1, 'Update guard leaves enabled stabilization and camera running');
    await page.click('#cancel');
    await ready();
    assert.equal(await count(), beforeCancel);
    assert.equal(await page.locator('#result').isVisible(), false);
    assert.equal(await page.locator('#stabilizationStatus').isVisible(), false);
    assert.equal(await page.locator('#stabilize').isEnabled(), true);
    await reset('textured');
    await settings();
    await page.fill('#duration', '1');
    await page.click('#shutter');
    await saved();
    assert.ok((await latest()).photo.framesUsed > 1, 'Restart after cancellation uses a fresh real tracker');
    const trackerCallsBeforeMoon = (await fixture()).trackers.length;
    await page.click('#moonOpen');
    await page.click('#moonDemo');
    await page.locator('#moonStorage[data-state="saved"]').waitFor({ timeout: 90000 });
    const moon = await latest();
    assert.equal(await page.locator('#stabilize').isChecked(), true);
    assert.equal(moon.photo.mode, 'moon');
    assert.equal(moon.photo.simulated, true);
    assert.ok(moon.photo.framesUsed > 1);
    assert.equal((await fixture()).trackers.length, trackerCallsBeforeMoon, 'Moon alignment is independent of the enabled main-camera tracker');
    assert.equal((await fixture()).liveTracks, 0);
    await page.click('#moonClose');
    console.log('PASS stabilization UI: trails, clean off/reload, flat-scene honest failure/restart, single-frame partial, cancellation, simulated update guard, independent Moon alignment');
    return { renderer: numerical, camera720p: uiError };
  } finally {
    await context.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser;
  try {
    const origin = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`Test server did not start: ${output}`)), 15000);
      server.on('error', reject);
      server.on('exit', code => reject(new Error(`Test server exited: ${code}`)));
      server.stderr.on('data', data => { output += data; });
      server.stdout.on('data', data => {
        output += data;
        const match = output.match(/http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
      });
    });
    browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--enable-unsafe-swiftshader'] });
    const errors = [];
    await runStabilizationChecks({ browser, origin, watchErrors: page => page.on('pageerror', error => errors.push(error.message)) });
    assert.deepEqual(errors, [], 'Unexpected stabilization JavaScript errors');
    console.log('PASS all focused stabilization checks (generated scenes, not physical-phone validation)');
  } finally {
    await browser?.close();
    if (server.exitCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
  }
}
