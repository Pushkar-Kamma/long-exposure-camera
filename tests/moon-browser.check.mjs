import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

export async function runMoonBrowserChecks({ browser, origin, watchErrors }) {
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, permissions: ['camera'] });
  await context.addInitScript(() => {
    const NativeWorker = globalThis.Worker;
    globalThis.moonWorkerRecords = [];
    globalThis.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        this.record = { url: String(url), type: options?.type, frames: 0, terminated: false };
        globalThis.moonWorkerRecords.push(this.record);
      }
      postMessage(message, ...rest) {
        if (message.type === 'frame') {
          this.record.frames++;
          this.record.width = message.frame.width;
        }
        return super.postMessage(message, ...rest);
      }
      terminate() { this.record.terminated = true; return super.terminate(); }
    };
  });
  const page = await context.newPage();
  watchErrors(page);
  const idle = () => page.waitForFunction(() => !document.querySelector('#moonDemo').disabled);
  const count = () => page.evaluate(async () => (await (await import('./gallery.js')).listPhotos(100)).total);
  const latest = () => page.evaluate(async () => {
    const { listPhotos, getPhoto } = await import('./gallery.js');
    const { entries, total } = await listPhotos(100);
    const photo = entries.length ? await getPhoto(entries[0].id) : null;
    return {
      total, entry: entries[0],
      photo: photo && { ...photo, blob: { size: photo.blob.size, type: photo.blob.type }, referenceBlob: { size: photo.referenceBlob?.size, type: photo.referenceBlob?.type } },
      hasHeavyEntry: entries.some(entry => 'blob' in entry || 'referenceBlob' in entry)
    };
  });
  const saved = async () => {
    await page.locator('#moonStorage[data-state="saved"]').waitFor({ timeout: 90000 });
    await idle();
    assert.equal(await page.locator('#moonResult').isVisible(), true);
    assert.equal(await page.locator('#moonError').isVisible(), false);
    assert.equal(await page.locator('#moonShare').isEnabled(), true);
  };
  const digestLink = selector => page.locator(selector).evaluate(async link => {
    const blob = await (await fetch(link.href)).blob();
    const bytes = await blob.arrayBuffer();
    const bitmap = await createImageBitmap(blob);
    const result = {
      size: blob.size, type: blob.type, width: bitmap.width, height: bitmap.height,
      digest: [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join(''),
      name: link.download
    };
    bitmap.close();
    return result;
  });
  const upload = async files => {
    await idle();
    await page.locator('#moonFiles').setInputFiles(files.map(file => ({
      name: file.name, mimeType: file.type, buffer: Buffer.from(file.base64, 'base64')
    })));
  };
  const expectError = async (files, pattern, expectedCount) => {
    await upload(files);
    await page.locator('#moonError').waitFor({ state: 'visible', timeout: 20000 });
    await idle();
    assert.match(await page.locator('#moonError').textContent(), pattern);
    assert.equal(await count(), expectedCount, 'Invalid input must not save a gallery result');
  };
  try {
    await page.goto(origin);
    await page.click('#moonOpen');
    await page.locator('#moonDialog').waitFor({ state: 'visible' });
    assert.match(await page.locator('#moonDemo').textContent(), /simulated/i);
    await page.click('#moonDemo');
    await saved();
    const demo = await latest();
    assert.equal(demo.total, 1);
    assert.equal(demo.photo.mode, 'moon');
    assert.equal(demo.photo.simulated, true);
    assert.equal(demo.photo.source, 'simulation');
    assert.equal(demo.photo.framesSampled, 48);
    assert.ok(demo.photo.framesUsed > 1);
    assert.match(demo.photo.name, /SIMULATED/);
    assert.match(await page.locator('#moonBadge').textContent(), /SIMULATED.*WATERMARKED/);
    assert.equal(demo.hasHeavyEntry, false);
    const workers = await page.evaluate(() => globalThis.moonWorkerRecords);
    assert.ok(workers.some(worker => worker.type === 'module' && worker.url.endsWith('/moon-worker.js') && worker.frames === 48 && worker.terminated), 'Demo uses and terminates the real module worker');
    const watermark = await page.locator('#moonOutput').evaluate(canvas => {
      const fontSize = Math.max(9, Math.round(canvas.width / 22));
      const pixels = canvas.getContext('2d').getImageData(0, canvas.height - fontSize * 2, canvas.width, fontSize * 2).data;
      let black = 0;
      let white = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] < 5 && pixels[i + 1] < 5) black++;
        if (pixels[i] > 220 && pixels[i + 1] > 220) white++;
      }
      return { black, white };
    });
    assert.ok(watermark.black > 1000 && watermark.white > 100, 'Rendered simulated export includes a black strip and white watermark text');
    const demoJPEG = await digestLink('#moonDownload');
    const referenceJPEG = await digestLink('#moonReferenceDownload');
    assert.equal(demoJPEG.type, 'image/jpeg');
    assert.match(referenceJPEG.name, /SIMULATED.*best-single\.jpg$/);
    assert.equal(demo.photo.referenceBlob.size, referenceJPEG.size);
    await page.click('#moonGallery');
    await page.locator('.gallery-card').waitFor();
    assert.match(await page.locator('.gallery-card').textContent(), /SIMULATED/);
    await page.locator('.gallery-card').click();
    await page.locator('#galleryViewer').waitFor({ state: 'visible' });
    assert.match(await page.locator('#galleryDetails').textContent(), /SIMULATED test scene, not a Moon photo/);
    assert.deepEqual(await digestLink('#galleryDownload'), demoJPEG);
    assert.deepEqual(await digestLink('#galleryReferenceDownload'), referenceJPEG);
    await page.click('#galleryClose');
    await page.click('#moonClose');
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await context.setOffline(true);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#galleryCount').textContent === '1');
    await page.click('#galleryOpen');
    await page.locator('.gallery-card').click();
    await page.locator('#galleryViewer').waitFor({ state: 'visible' });
    assert.deepEqual(await digestLink('#galleryReferenceDownload'), referenceJPEG);
    assert.match(await page.locator('#galleryDetails').textContent(), /SIMULATED/);
    await page.click('#galleryClose');
    await context.setOffline(false);
    await page.click('#moonOpen');
    console.log('PASS Moon demo: real module worker, watermarked SIMULATED exports, metadata-only entries, reference persistence offline');

    const fixtures = await page.evaluate(async () => {
      const { createMoonSimulation } = await import('./moon-simulation.js');
      const { analyzeMoon } = await import('./moon-core.js');
      const simulation = createMoonSimulation({ count: 6, width: 256, height: 256, seed: 2026 });
      const truth = document.createElement('canvas');
      truth.width = truth.height = 256;
      truth.getContext('2d').putImageData(new ImageData(simulation.truth.data, 256, 256), 0, 0);
      const source = document.createElement('canvas');
      source.width = source.height = 1024;
      const ctx = source.getContext('2d');
      const fill = () => { ctx.fillStyle = '#121212'; ctx.fillRect(0, 0, 1024, 1024); };
      fill();
      ctx.drawImage(truth, 384, 384);
      const encode = (canvas, name) => ({ name, type: 'image/png', base64: canvas.toDataURL('image/png').split(',')[1] });
      const single = encode(source, 'explicitly-synthetic-single.png');
      const small = encode(truth, 'explicitly-synthetic-different-resolution.png');
      const detector = document.createElement('canvas');
      detector.width = detector.height = 512;
      detector.getContext('2d').drawImage(source, 0, 0, 512, 512);
      const detection = analyzeMoon(detector.getContext('2d').getImageData(0, 0, 512, 512));
      if (!detection.ok) throw new Error(detection.reason);
      const cropPixels = Math.min(1024, Math.max(24, Math.ceil(detection.diameter * 2 * 1.8)));
      const crop = document.createElement('canvas');
      crop.width = crop.height = Math.min(384, cropPixels);
      const x = Math.max(0, Math.min(1024 - cropPixels, detection.centerX * 2 - cropPixels / 2));
      const y = Math.max(0, Math.min(1024 - cropPixels, detection.centerY * 2 - cropPixels / 2));
      crop.getContext('2d').drawImage(source, x, y, cropPixels, cropPixels, 0, 0, crop.width, crop.height);
      const expectedPixels = crop.getContext('2d').getImageData(0, 0, crop.width, crop.height).data;
      globalThis.expectedNativeCrop = { width: crop.width, height: crop.height, data: expectedPixels };
      const shifted = [];
      let index = 0;
      for (const frame of simulation.frames) {
        truth.getContext('2d').putImageData(new ImageData(frame.data, 256, 256), 0, 0);
        fill();
        ctx.drawImage(truth, 384 + index * 3, 384 - index * 2);
        shifted.push(encode(source, `explicitly-synthetic-shift-${index++}.png`));
      }
      fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(512, 512, 77, 0, Math.PI * 2); ctx.fill();
      const clipped = encode(source, 'explicitly-synthetic-clipped.png');
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 1024, 1024);
      const dark = encode(source, 'explicitly-synthetic-dark.png');
      return { single, small, shifted, clipped, dark, cropPixels, outputSize: crop.width };
    });
    await upload([fixtures.single]);
    await saved();
    const single = await latest();
    assert.equal(single.photo.simulated, false, 'Imported files are labelled as imports, not as the built-in simulated demo');
    assert.equal(single.photo.source, 'imported-photos');
    assert.equal(single.photo.framesUsed, 1);
    assert.equal(single.photo.inputDimensions, '1024 x 1024');
    assert.equal(single.photo.width, fixtures.outputSize);
    assert.ok(single.photo.width <= 384 && single.photo.width <= fixtures.cropPixels);
    assert.match(await page.locator('#moonBadge').textContent(), /SINGLE FRAME \/ NOT A STACK/);
    assert.match(await page.locator('#moonStats').textContent(), /no stacking improvement|Single-frame/);
    const cropMatches = await page.locator('#moonReference').evaluate(canvas => {
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      const expected = globalThis.expectedNativeCrop;
      return canvas.width === expected.width && pixels.every((value, index) => value === expected.data[index]);
    });
    assert.equal(cropMatches, true, 'Best-single reference preserves the actual native-resolution crop pixels');
    const singleJPEG = await digestLink('#moonDownload');
    assert.equal(singleJPEG.digest, (await digestLink('#moonReferenceDownload')).digest);
    await upload([fixtures.single, { ...fixtures.single, name: 'explicitly-synthetic-identical-copy.png' }]);
    await saved();
    const duplicates = await latest();
    assert.equal(duplicates.photo.framesSampled, 2);
    assert.equal(duplicates.photo.framesUsed, 1, 'Identical imported files cannot imply independent stacking improvement');
    assert.match(await page.locator('#moonBadge').textContent(), /SINGLE FRAME \/ NOT A STACK/);
    assert.match(await page.locator('#moonStats').textContent(), /Single-frame.*no stacking improvement/);
    await upload(fixtures.shifted);
    await saved();
    const aligned = await latest();
    assert.ok(aligned.photo.framesUsed > 1 && aligned.photo.framesUsed <= 6);
    assert.equal(aligned.photo.framesSampled, 6);
    assert.match(await page.locator('#moonBadge').textContent(), /ALIGNED MOON RESULT/);
    assert.ok(aligned.photo.width <= 384);
    await upload([fixtures.single, fixtures.small]);
    await saved();
    const mixedResolution = await latest();
    assert.equal(mixedResolution.photo.framesSampled, 2);
    assert.equal(mixedResolution.photo.framesUsed, 1, 'Different-resolution images must be skipped, never stretched into a sequence');
    assert.equal(mixedResolution.photo.inputDimensions, '1024 x 1024');
    assert.equal(mixedResolution.photo.width, fixtures.outputSize);
    assert.match(await page.locator('#moonBadge').textContent(), /SINGLE FRAME \/ NOT A STACK/);
    console.log('PASS Moon PNG imports: honest single-frame result, exact native crop/reference pixels, shifted-frame alignment without upscaling');

    const beforeInvalid = await count();
    await expectError([fixtures.clipped], /clipp|saturat|exposure/i, beforeInvalid);
    assert.equal(await page.locator('#moonResult').isVisible(), false);
    await expectError([fixtures.dark], /Moon.*dark sky|No.*Moon|Aim|exposed/i, beforeInvalid);
    assert.equal(await page.locator('#moonResult').isVisible(), false);
    const badVideo = { name: 'invalid.webm', type: 'video/webm', base64: Buffer.from('not a video').toString('base64') };
    await expectError([fixtures.single, badVideo], /not a mixture|either photos or one video/i, beforeInvalid);
    await expectError(Array.from({ length: 21 }, (_, index) => ({ ...fixtures.single, name: `synthetic-${index}.png` })), /at most 20/i, beforeInvalid);
    await expectError([{ name: 'unsupported.dng', type: 'application/octet-stream', base64: 'YWJj' }], /RAW\/DNG|supported photos/i, beforeInvalid);
    await page.evaluate(() => {
      const file = new File(['size-only fixture'], 'oversize.png', { type: 'image/png' });
      Object.defineProperty(file, 'size', { value: 40 * 1024 * 1024 + 1 });
      Object.defineProperty(document.querySelector('#moonFiles'), 'files', { configurable: true, value: [file] });
      document.querySelector('#moonFiles').dispatchEvent(new Event('change'));
      delete document.querySelector('#moonFiles').files;
    });
    assert.match(await page.locator('#moonError').textContent(), /under 40 MB.*250 MB/);
    assert.equal(await count(), beforeInvalid);
    await expectError([{ name: 'broken.png', type: 'image/png', base64: 'bm90IGFuIGltYWdl' }], /decode|JPEG/i, beforeInvalid);
    await expectError([badVideo], /decode|video/i, beforeInvalid);
    console.log('PASS Moon input rejection: clipped/dark, mixed types, >20 files, oversized metadata, unsupported format and bad decodes save nothing');

    const clip = await page.evaluate(async () => {
      if (!globalThis.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return null;
      const type = ['video/webm;codecs=vp8', 'video/webm'].find(value => MediaRecorder.isTypeSupported(value));
      if (!type) return null;
      const { createMoonSimulation } = await import('./moon-simulation.js');
      const frames = [...createMoonSimulation({ count: 6, width: 256, height: 256 }).frames];
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      const ctx = canvas.getContext('2d');
      ctx.putImageData(new ImageData(frames[0].data, 256, 256), 0, 0);
      const stream = canvas.captureStream(20);
      const recorder = new MediaRecorder(stream, { mimeType: type });
      const chunks = [];
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      const stopped = new Promise(resolve => { recorder.onstop = resolve; });
      recorder.start();
      let frame = 0;
      const timer = setInterval(() => ctx.putImageData(new ImageData(frames[frame++ % frames.length].data, 256, 256), 0, 0), 50);
      await new Promise(resolve => setTimeout(resolve, 1200));
      recorder.stop();
      await stopped;
      clearInterval(timer);
      stream.getTracks().forEach(track => track.stop());
      const blob = new Blob(chunks, { type: 'video/webm' });
      return await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve({ name: 'explicitly-synthetic-moon.webm', type: 'video/webm', base64: reader.result.split(',')[1] });
        reader.readAsDataURL(blob);
      });
    });
    if (clip) {
      await upload([clip]);
      await saved();
      const video = await latest();
      assert.equal(video.photo.source, 'imported-video');
      assert.ok(video.photo.framesSampled > 1 && video.photo.framesUsed > 1);
      assert.ok(video.photo.actual > 0 && video.photo.requested <= 8);
      console.log(`PASS generated MediaRecorder WebM import: ${video.photo.framesSampled} sequentially sought frames`);
    } else console.log('SKIP generated video fixture: this Chromium does not support MediaRecorder WebM');

    await page.evaluate(async () => {
      const { createMoonSimulation } = await import('./moon-simulation.js');
      const simulation = createMoonSimulation({ count: 6, width: 256, height: 256 });
      const frames = [...simulation.frames];
      globalThis.moonCameraTest = { streams: [], requests: [], mode: 'supported', constraintMode: 'confirm', stillMode: 'ok', stillRequests: 0 };
      Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { configurable: true, value: async () => [
        { kind: 'videoinput', label: 'Synthetic wide', deviceId: 'synthetic-wide' },
        { kind: 'videoinput', label: 'Synthetic telephoto', deviceId: 'synthetic-tele' }
      ] });
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async constraints => {
        const test = globalThis.moonCameraTest;
        test.requests.push(constraints);
        if (test.mode === 'denied') throw new DOMException('Synthetic permission denial', 'NotAllowedError');
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 256;
        const ctx = canvas.getContext('2d');
        ctx.putImageData(new ImageData(frames[0].data, 256, 256), 0, 0);
        const stream = canvas.captureStream(20);
        const track = stream.getVideoTracks()[0];
        const actual = { width: 256, height: 256, exposureCompensation: 0, zoom: 1 };
        const timer = setInterval(() => {
          const frame = frames[Math.floor(performance.now() / 90) % frames.length];
          ctx.putImageData(new ImageData(frame.data, 256, 256), 0, 0);
        }, 50);
        const stop = track.stop.bind(track);
        track.stop = () => { clearInterval(timer); stop(); };
        track.getCapabilities = () => test.mode === 'supported' ? {
          exposureCompensation: { min: -2, max: 2, step: 0.5 }, zoom: { min: 1, max: 4, step: 0.5 }
        } : test.mode === 'degenerate' ? {
          exposureCompensation: { min: 0, max: 0 }, zoom: { min: NaN, max: 4 }
        } : {};
        track.getSettings = () => ({ ...actual });
        track.applyConstraints = async constraints => {
          if (test.constraintMode === 'denied') throw new DOMException('Synthetic constraint denial', 'OverconstrainedError');
          if (test.constraintMode === 'confirm') Object.assign(actual, constraints.advanced[0]);
        };
        test.streams.push(stream);
        if (test.mode === 'pending-permission') await new Promise(resolve => { test.resolvePermission = resolve; });
        return stream;
      } });
      const photoCanvas = document.createElement('canvas');
      photoCanvas.width = photoCanvas.height = 1024;
      const photoContext = photoCanvas.getContext('2d');
      photoContext.fillStyle = '#121212'; photoContext.fillRect(0, 0, 1024, 1024);
      photoContext.putImageData(new ImageData(simulation.truth.data, 256, 256), 384, 384);
      const stillBlob = await new Promise(resolve => photoCanvas.toBlob(resolve, 'image/png'));
      globalThis.ImageCapture = class {
        async getPhotoCapabilities() { return { fillLightMode: ['off'] }; }
        async takePhoto(options) {
          const test = globalThis.moonCameraTest;
          test.stillRequests++;
          test.stillOptions = options;
          if (test.stillMode === 'pending') return new Promise(() => {});
          if (test.stillMode === 'unsupported') throw new DOMException('Synthetic still capture unsupported', 'NotSupportedError');
          return stillBlob;
        }
      };
    });
    const enableCamera = async () => {
      await idle();
      await page.click('#moonEnable');
      await page.waitForFunction(() => !document.querySelector('#moonCapture').disabled);
    };
    await enableCamera();
    assert.equal(await page.locator('#moonExposureControl').isVisible(), true);
    assert.equal(await page.locator('#moonZoomControl').isVisible(), true);
    assert.equal(await page.locator('#moonStill').isVisible(), true);
    assert.match(await page.locator('#moonCamera').textContent(), /Synthetic telephoto/);
    await page.selectOption('#moonCamera', 'synthetic-tele');
    await page.waitForFunction(() => !document.querySelector('#moonCapture').disabled);
    assert.equal(await page.evaluate(() => globalThis.moonCameraTest.requests.at(-1).video.deviceId.exact), 'synthetic-tele');
    const control = async (selector, value) => {
      await page.locator(selector).evaluate((input, value) => { input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })); }, value);
      await idle();
    };
    await control('#moonExposure', '-1');
    assert.equal(await page.locator('#moonExposureValue').textContent(), '-1.0');
    assert.match(await page.locator('#moonStatus').textContent(), /confirmed/);
    await page.evaluate(() => { globalThis.moonCameraTest.constraintMode = 'ignore'; });
    await control('#moonZoom', '2');
    assert.match(await page.locator('#moonError').textContent(), /not confirmed.*did not confirm/);
    assert.equal(await page.locator('#moonZoom').inputValue(), '1');
    await page.evaluate(() => { globalThis.moonCameraTest.constraintMode = 'denied'; });
    await control('#moonExposure', '-2');
    assert.match(await page.locator('#moonError').textContent(), /not confirmed.*denial/);
    assert.equal(await page.locator('#moonExposure').inputValue(), '-1');
    await page.evaluate(() => { globalThis.moonCameraTest.constraintMode = 'confirm'; });
    await control('#moonZoom', '2');
    assert.equal(await page.locator('#moonZoomValue').textContent(), '2.0');
    await page.evaluate(() => {
      const track = document.querySelector('#moonVideo').srcObject.getVideoTracks()[0];
      const apply = track.applyConstraints.bind(track);
      track.applyConstraints = async constraints => {
        await new Promise(resolve => { globalThis.resolveMoonControl = resolve; });
        return apply(constraints);
      };
      const input = document.querySelector('#moonZoom');
      input.value = '2.5';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    assert.equal(await page.locator('#moonCapture').isDisabled(), true);
    assert.equal(await page.locator('#moonCamera').isDisabled(), true);
    assert.equal(await page.locator('#moonFiles').isDisabled(), true);
    await page.evaluate(() => globalThis.resolveMoonControl());
    await idle();
    assert.equal(await page.locator('#moonZoomValue').textContent(), '2.5');
    assert.equal(await page.locator('#moonCapture').isEnabled(), true);
    await page.selectOption('#moonDuration', '3');
    const burstStarted = performance.now();
    await page.click('#moonCapture');
    await saved();
    const burst = await latest();
    assert.equal(burst.photo.source, 'camera-burst');
    assert.equal(burst.photo.requested, 3);
    assert.ok(burst.photo.framesSampled > 1 && burst.photo.framesUsed > 1);
    assert.ok(burst.photo.actual >= 2 && performance.now() - burstStarted < 30000);
    assert.equal(await page.evaluate(() => globalThis.moonCameraTest.streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended'))), true);
    console.log(`PASS synthetic live Moon burst: ${burst.photo.framesSampled} sampled / ${burst.photo.framesUsed} stacked, selectors and truthful capability/readback controls`);

    for (const mode of ['absent', 'degenerate']) {
      await page.evaluate(mode => { globalThis.moonCameraTest.mode = mode; }, mode);
      await enableCamera();
      assert.equal(await page.locator('#moonExposureControl').isVisible(), false);
      assert.equal(await page.locator('#moonZoomControl').isVisible(), false);
    }
    await page.evaluate(() => { globalThis.moonCameraTest.mode = 'supported'; });
    await enableCamera();
    await page.click('#moonStill');
    await saved();
    const still = await latest();
    assert.equal(still.photo.source, 'camera-still');
    assert.equal(still.photo.inputDimensions, '1024 x 1024');
    assert.equal(still.photo.framesUsed, 1);
    assert.ok(still.photo.width <= 384);
    assert.deepEqual(await page.evaluate(() => globalThis.moonCameraTest.stillOptions), { fillLightMode: 'off' });
    const beforeCancel = await count();
    await page.evaluate(() => { globalThis.moonCameraTest.stillMode = 'unsupported'; });
    await enableCamera();
    await page.click('#moonStill');
    await page.locator('#moonError').waitFor({ state: 'visible' });
    await idle();
    assert.match(await page.locator('#moonError').textContent(), /unsupported/);
    assert.equal(await count(), beforeCancel);
    await page.evaluate(() => { globalThis.moonCameraTest.stillMode = 'pending'; });
    await enableCamera();
    await page.click('#moonStill');
    await page.locator('#moonCancel').waitFor({ state: 'visible' });
    await page.click('#moonCancel');
    await idle();
    assert.equal(await count(), beforeCancel);
    assert.equal(await page.locator('#moonResult').isVisible(), false);
    await enableCamera();
    await page.selectOption('#moonDuration', '3');
    await page.click('#moonCapture');
    await page.waitForFunction(() => globalThis.moonWorkerRecords.at(-1).frames > 0);
    page.once('dialog', dialog => dialog.accept());
    await page.click('#moonClose');
    await page.locator('#moonDialog').waitFor({ state: 'hidden' });
    await page.waitForTimeout(3500);
    assert.equal(await count(), beforeCancel);
    assert.equal(await page.evaluate(() => globalThis.moonCameraTest.streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended'))), true);
    assert.equal(await page.evaluate(() => globalThis.moonWorkerRecords.every(worker => worker.terminated)), true);
    await page.click('#moonOpen');
    await page.evaluate(() => { globalThis.moonCameraTest.mode = 'denied'; });
    await page.click('#moonEnable');
    await idle();
    assert.match(await page.locator('#moonError').textContent(), /could not start.*permission denial/);
    await page.evaluate(() => { globalThis.moonCameraTest.mode = 'pending-permission'; });
    await page.click('#moonEnable');
    await page.waitForFunction(() => typeof globalThis.moonCameraTest.resolvePermission === 'function');
    page.once('dialog', dialog => dialog.accept());
    await page.click('#moonClose');
    await page.locator('#moonDialog').waitFor({ state: 'hidden' });
    await page.evaluate(() => globalThis.moonCameraTest.resolvePermission());
    await page.waitForFunction(() => globalThis.moonCameraTest.streams.at(-1).getTracks().every(track => track.readyState === 'ended'));
    assert.equal(await page.locator('#moonVideo').evaluate(video => video.srcObject), null);
    assert.equal(await page.locator('#moonDialog').isVisible(), false);
    await page.click('#moonOpen');
    console.log('PASS still-photo native dimensions, unsupported API error, pending still cancellation, burst close cleanup and denied camera');

    const timeout = await page.evaluate(async () => {
      const { cameraOperation, mediaEvent, nextVideoFrame } = await import('./moon-media.js');
      const original = globalThis.setTimeout;
      globalThis.setTimeout = (callback, ms, ...args) => original(callback, [15000, 2500, 10000].includes(ms) ? 20 : ms, ...args);
      const result = {};
      try {
        try { await cameraOperation(new Promise(() => {}), new AbortController().signal); }
        catch (error) { result.camera = error.message; }
        let cancelledFrame = false;
        try {
          await nextVideoFrame({
            requestVideoFrameCallback() { return 42; },
            cancelVideoFrameCallback(handle) { cancelledFrame = handle === 42; }
          }, new AbortController().signal);
        } catch (error) { result.stall = error.message; }
        result.cancelledFrame = cancelledFrame;
        try { await mediaEvent(new EventTarget(), 'loadeddata', new AbortController().signal, () => {}); }
        catch (error) { result.media = error.message; }
        return result;
      }
      finally { globalThis.setTimeout = original; }
    });
    assert.match(timeout.camera, /did not respond.*native-camera photos/);
    assert.match(timeout.stall, /stopped supplying frames/);
    assert.equal(timeout.cancelledFrame, true);
    assert.match(timeout.media, /decoding timed out.*shorter video/);
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      globalThis.failMoonSave = true;
      IDBObjectStore.prototype.put = function (...args) {
        if (globalThis.failMoonSave && this.name === 'entries') throw new DOMException('Injected Moon gallery quota failure', 'QuotaExceededError');
        return put.apply(this, args);
      };
    });
    await upload([fixtures.single]);
    await page.locator('#moonStorage[data-state="failed"]').waitFor();
    await idle();
    assert.match(await page.locator('#moonStorage').textContent(), /Not saved.*quota failure.*Download or share/);
    assert.equal(await page.locator('#moonShare').isEnabled(), true);
    const unsavedJPEG = await digestLink('#moonDownload');
    const unsavedReference = await digestLink('#moonReferenceDownload');
    assert.equal(await count(), beforeCancel);
    let confirmMessage = '';
    page.once('dialog', async dialog => { confirmMessage = dialog.message(); await dialog.dismiss(); });
    await page.click('#moonClose');
    assert.match(confirmMessage, /not saved.*Close anyway/);
    assert.equal(await page.locator('#moonDialog').isVisible(), true);
    assert.deepEqual(await digestLink('#moonDownload'), unsavedJPEG);
    assert.equal(await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }), true);
    await page.evaluate(() => { globalThis.failMoonSave = false; });
    await page.click('#moonRetry');
    await saved();
    assert.equal(await count(), beforeCancel + 1);
    assert.deepEqual(await digestLink('#moonReferenceDownload'), unsavedReference);
    assert.equal((await latest()).hasHeavyEntry, false);
    console.log('PASS Moon bounded camera timeout, atomic gallery failure, usable exports, close/navigation warnings and retry');
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
      server.stderr.on('data', data => { output += data; });
      server.stdout.on('data', data => {
        output += data;
        const match = output.match(/http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
      });
    });
    browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--enable-unsafe-swiftshader'] });
    const errors = [];
    await runMoonBrowserChecks({ browser, origin, watchErrors: page => page.on('pageerror', error => errors.push(error.message)) });
    assert.deepEqual(errors, [], 'Unexpected Moon JavaScript errors');
    console.log('PASS all focused Moon browser checks (synthetic fixtures; not physical iPhone validation)');
  } finally {
    await browser?.close();
    if (server.exitCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
  }
}
