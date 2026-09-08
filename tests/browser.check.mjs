import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { chromium } from 'playwright';
import { checkUpgradedUX } from './ux.check.mjs';

const server = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, PORT: '0' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let browser;
let proxy;
const errors = [];
try {
  const origin = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 15000);
    server.on('error', reject);
    server.on('exit', code => reject(new Error(`Server exited: ${code}`)));
    server.stderr.on('data', data => { output += data; });
    server.stdout.on('data', data => {
      output += data;
      const match = output.match(/http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
  });
  assert.equal((await fetch(origin)).status, 200);
  browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--enable-unsafe-swiftshader']
  });
  const context = await browser.newContext({ permissions: ['camera'], viewport: { width: 430, height: 932 } });
  const page = await context.newPage();
  const watchErrors = target => {
    target.on('pageerror', error => errors.push(error.message));
    target.on('console', message => {
      if (message.type() === 'error' && !/favicon\.ico/.test(message.location().url || '')) errors.push(message.text());
    });
  };
  watchErrors(page);
  await page.goto(origin);
  const renderer = await page.evaluate(async () => {
    const { FrameStacker } = await import('./stacker.js');
    const canvas = document.createElement('canvas');
    const stacker = new FrameStacker(canvas);
    const gl = stacker.gl;
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const close = (actual, expected, label, tolerance = 2) => check(Math.abs(actual - expected) <= tolerance, `${label}: ${actual}, expected ${expected}`);
    const frame = (width, height, pixels) => {
      const source = document.createElement('canvas');
      source.width = width;
      source.height = height;
      source.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
      return source;
    };
    const read = () => {
      stacker.render();
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      check(gl.getError() === gl.NO_ERROR, 'WebGL error reading rendered image');
      return [...pixels];
    };
    const black = frame(1, 1, [0, 0, 0, 255]);
    const white = frame(1, 1, [255, 255, 255, 255]);
    stacker.reset(1, 1, 'average');
    stacker.add(black);
    stacker.add(white);
    close(read()[0], 188, 'Linear-light average (not sRGB 128)');
    stacker.render(-1);
    const dimmed = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, dimmed);
    close(dimmed[0], 137, '-1 EV scales linear light');

    stacker.reset(1, 1, 'trails');
    stacker.add(frame(1, 1, [200, 30, 80, 255]));
    stacker.add(frame(1, 1, [20, 180, 60, 255]));
    [200, 180, 80, 255].forEach((expected, channel) => close(read()[channel], expected, `Trail channel ${channel}`));

    // DOM image coordinates are top-down; WebGL readPixels is bottom-up.
    const asymmetric = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255];
    stacker.reset(2, 2, 'average');
    stacker.add(frame(2, 2, asymmetric));
    const oriented = read();
    [...asymmetric.slice(8), ...asymmetric.slice(0, 8)].forEach((expected, i) => close(oriented[i], expected, `Orientation channel ${i}`));
    const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const bitmap = await createImageBitmap(png);
    const decoded = document.createElement('canvas');
    decoded.width = 2;
    decoded.height = 2;
    const ctx = decoded.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    [...ctx.getImageData(0, 0, 2, 2).data].forEach((actual, i) => close(actual, asymmetric[i], `Export orientation ${i}`));
    bitmap.close();
    const jpeg = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.96));
    check(jpeg?.type === 'image/jpeg' && jpeg.size > 100, 'Nonempty JPEG');
    const jpegImage = await createImageBitmap(jpeg);
    check(jpegImage.width === 2 && jpegImage.height === 2, 'JPEG dimensions');
    jpegImage.close();

    stacker.reset(1, 1, 'average');
    for (let i = 0; i < 10001; i++) stacker.add(white);
    const sum = () => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, stacker.targets[stacker.current].framebuffer);
      const value = new Float32Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, value);
      check(gl.getError() === gl.NO_ERROR, 'Float buffer read failed');
      return value[0];
    };
    const before = sum();
    close(before, 10001, 'Float32 sum after 10001 frames', 0.05);
    stacker.add(frame(1, 1, [128, 128, 128, 255]));
    const delta = sum() - before;
    close(delta, 0.21586, 'Late midtone contribution', 0.002);
    for (let i = 0; i < 1000; i++) stacker.add(black);
    close(read()[0], 245, 'Late dark frames still change long average');
    check(stacker.frames === 11002, 'Long-stack frame count');
    stacker.releaseImages();
    check(stacker.frames === 0 && stacker.targets.length === 0 && stacker.input === null, 'GPU image cleanup');
    stacker.dispose();
    return { renderer: gl.getParameter(gl.RENDERER), precisionFrames: 11002, lateDelta: delta };
  });
  console.log('PASS renderer: linear average, max trails, orientation, JPEG, EV, >10000-frame precision', renderer);

  const enabled = async selector => {
    await page.waitForFunction(id => !document.querySelector(id).disabled && !document.querySelector(id).hidden, selector);
  };
  const openSettings = async () => {
    if (!await page.locator('#settingsPanel').evaluate(panel => panel.open)) await page.click('#settingsToggle');
    await page.locator('#duration').waitFor({ state: 'visible' });
  };
  const ready = async () => {
    await enabled('#shutter');
    await openSettings();
  };
  const result = async () => {
    await enabled('#share');
    await page.locator('#photoStorage[data-state="saved"]').waitFor();
    assert.equal(await page.locator('#result').isVisible(), true);
    assert.equal(await page.locator('#error').isVisible(), false);
  };
  const photo = async () => page.evaluate(async () => {
    const link = document.querySelector('#download');
    const blob = await (await fetch(link.href)).blob();
    const bitmap = await createImageBitmap(blob);
    const result = { size: blob.size, type: blob.type, width: bitmap.width, height: bitmap.height, name: link.download, url: link.href };
    bitmap.close();
    return result;
  });
  assert.equal(await page.locator('#settingsPanel').evaluate(panel => panel.open), false);
  await openSettings();
  await page.selectOption('#quality', '720');
  await page.selectOption('#delay', '0');
  await page.click('#enable');
  await ready();
  assert.ok((await page.locator('#resolution').textContent()).match(/\d+ x \d+/));
  for (const invalid of ['', '0', '601', '1.5', '-1']) {
    await page.fill('#duration', invalid);
    await page.click('#shutter');
    assert.match(await page.locator('#error').textContent(), /whole number/);
    assert.equal(await page.locator('#result').isVisible(), false);
    await ready();
  }
  await page.fill('#duration', '1');
  await page.click('#shutter');
  await result();
  assert.equal(await page.locator('#badge').textContent(), 'EXPOSURE COMPLETE');
  assert.equal(await page.locator('#clock').textContent(), '00:01');
  assert.match(await page.locator('#summary').textContent(), /\/ 1s set/);
  assert.ok(Number((await page.locator('#frames').textContent()).replace(/\D/g, '')) >= 2, 'One-second exposure must contain multiple camera frames');
  const first = await photo();
  assert.equal(first.type, 'image/jpeg');
  assert.ok(first.size > 1000);
  assert.match(first.name, /average-.*-complete-/);
  assert.deepEqual([first.width, first.height], await page.locator('#output').evaluate(canvas => [canvas.width, canvas.height]));
  await page.locator('#ev').evaluate(input => { input.value = '1'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await result();
  const brighter = await photo();
  assert.notEqual(brighter.url, first.url);
  assert.equal(await page.locator('#evLabel').textContent(), '+1.0 EV');
  console.log('PASS UI: fake camera, invalid custom durations, one-second average, JPEG, brightness re-export');

  await page.click('#again');
  await ready();
  assert.equal(await page.locator('#download').getAttribute('href'), null);
  await page.check('input[value="trails"]');
  await page.fill('#duration', '1');
  await page.click('#shutter');
  await result();
  assert.match((await photo()).name, /trails-.*-complete-/);
  await page.click('#again');
  await ready();
  await page.fill('#duration', '600');
  await page.click('#shutter');
  await enabled('#finish');
  const livePreview = await page.evaluate(() => {
    const video = document.querySelector('#video');
    const output = document.querySelector('#output');
    const bounds = element => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      videoHidden: video.hidden,
      outputHidden: output.hidden,
      videoDisplay: getComputedStyle(video).display,
      paused: video.paused,
      videoBounds: bounds(video),
      outputBounds: bounds(output),
      time: video.currentTime
    };
  });
  assert.equal(livePreview.videoHidden, false, 'Camera video stays laid out during stacking');
  assert.equal(livePreview.outputHidden, false);
  assert.notEqual(livePreview.videoDisplay, 'none');
  assert.equal(livePreview.paused, false);
  assert.deepEqual(livePreview.videoBounds, livePreview.outputBounds, 'Preview and stack overlay occupy the same rectangle');
  assert.ok(livePreview.videoBounds.width > 0 && livePreview.videoBounds.height > 0);
  await page.waitForFunction(time => {
    const frames = Number(document.querySelector('#frames').textContent.replace(/\D/g, ''));
    return document.querySelector('#video').currentTime > time + 0.2 && frames >= 5;
  }, livePreview.time);
  console.log('PASS live preview: overlapping video/canvas remain laid out and camera frames keep advancing');
  await page.click('#finish');
  await result();
  assert.equal(await page.locator('#badge').textContent(), 'FINISHED EARLY');
  assert.match((await photo()).name, /-stopped-/);
  assert.match(await page.locator('#summary').textContent(), /\/ 600s set/);
  await page.click('#again');
  await ready();
  await page.click('#shutter');
  await enabled('#finish');
  await page.click('#cancel');
  await ready();
  assert.equal(await page.locator('#result').isVisible(), false);
  assert.match(await page.locator('#status').textContent(), /cancelled/);
  await page.selectOption('#delay', '3');
  await page.click('#shutter');
  await page.locator('#countdown').waitFor({ state: 'visible' });
  await page.click('#cancel');
  await ready();
  assert.equal(await page.locator('#result').isVisible(), false);
  console.log('PASS UI: repeat shot, trails mode, 600-second stop-and-keep, capture and countdown cancellation');

  await page.selectOption('#delay', '0');
  await page.selectOption('#quality', '1080');
  await ready();
  await page.check('input[value="average"]');
  await page.click('button[data-seconds="10"]');
  const fullHD = await page.locator('#video').evaluate(video => {
    const track = video.srcObject.getVideoTracks()[0];
    return { constraints: track.getConstraints(), width: video.videoWidth, height: video.videoHeight };
  });
  assert.equal(fullHD.constraints.width.ideal ?? fullHD.constraints.width, 1920);
  assert.equal(fullHD.constraints.height.ideal ?? fullHD.constraints.height, 1080);
  assert.deepEqual([fullHD.width, fullHD.height], [1920, 1080]);
  const started = performance.now();
  await page.click('#shutter');
  await enabled('#finish');
  assert.equal(await page.locator('#settingsPanel').isVisible(), false);
  assert.equal(await page.locator('#settingsPanel').evaluate(panel => panel.open), false);
  await page.waitForFunction(() => /00:10 left/.test(document.querySelector('#remaining').textContent));
  assert.equal(await page.locator('#remaining').isVisible(), true);
  await page.waitForFunction(() => /00:09 left/.test(document.querySelector('#remaining').textContent));
  await result();
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 9500 && elapsed < 20000, `Ten-second capture/export took ${elapsed.toFixed(0)}ms`);
  assert.equal(await page.locator('#badge').textContent(), 'EXPOSURE COMPLETE');
  assert.equal(await page.locator('#clock').textContent(), '00:10');
  assert.equal(await page.locator('#progress').evaluate(progress => progress.value), 1);
  const fullSummary = await page.locator('#summary').textContent();
  assert.match(fullSummary, /\/ 10s set/);
  assert.ok(parseFloat(fullSummary) >= 8.5, `Actual stacked time too short: ${fullSummary}`);
  const fullPhoto = await photo();
  assert.deepEqual([fullPhoto.width, fullPhoto.height], [1920, 1080]);
  assert.match(fullPhoto.name, /average-.*-complete-/);
  assert.ok(fullPhoto.size > 1000);
  console.log(`PASS ten-second 1080p auto-finish: ${elapsed.toFixed(0)}ms, ${fullSummary}, 1920x1080 JPEG`);

  await page.click('#again');
  await ready();
  await page.selectOption('#quality', '720');
  await ready();
  await page.fill('#duration', '30');
  await page.click('#shutter');
  await enabled('#finish');
  await page.waitForFunction(() => Number(document.querySelector('#frames').textContent.replace(/\D/g, '')) >= 3);
  await page.locator('#video').evaluate(video => video.pause());
  await result();
  assert.equal(await page.locator('#badge').textContent(), 'INTERRUPTED / PARTIAL');
  assert.match(await page.locator('#notice').textContent(), /No new camera frames arrived.*partial exposure/);
  assert.match(await page.locator('#status').textContent(), /partial exposure/);
  assert.ok(await page.locator('#progress').evaluate(progress => progress.value < 1));
  const stalledPhoto = await photo();
  assert.match(stalledPhoto.name, /-incomplete-/);
  assert.ok(stalledPhoto.size > 1000);
  assert.deepEqual([stalledPhoto.width, stalledPhoto.height], [1280, 720]);
  console.log('PASS stalled camera: paused frame delivery produces an explicitly partial, savable JPEG');

  await page.click('#again');
  await ready();
  await page.click('#shutter');
  await enabled('#finish');
  // Headless windows do not reliably background; exercise the real handler with a simulated hidden document.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
    } finally {
      delete document.hidden;
    }
  });
  await result();
  assert.equal(await page.locator('#badge').textContent(), 'INTERRUPTED / PARTIAL');
  assert.match(await page.locator('#notice').textContent(), /left the foreground or the screen locked.*partial exposure/);
  const hiddenPhoto = await photo();
  assert.match(hiddenPhoto.name, /-incomplete-/);
  assert.ok(hiddenPhoto.size > 1000);
  assert.equal(await page.locator('#video').evaluate(video => video.srcObject), null);
  assert.equal(await page.evaluate(() => document.hidden), false);
  console.log('PASS simulated document.hidden interruption: camera stops and partial JPEG remains savable');

  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  await page.reload();
  await page.locator('#enable').waitFor();
  assert.match(await page.title(), /Still/);
  await context.setOffline(false);
  console.log('PASS PWA: root service worker offline reload');

  // Reverse proxy the real app server under a repository prefix, like GitHub Pages.
  proxy = http.createServer(async (request, response) => {
    const prefix = '/long-exposure-camera';
    if (!request.url.startsWith(`${prefix}/`)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const upstream = await fetch(`${origin}${request.url.slice(prefix.length)}`);
      response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('Content-Type') });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      response.writeHead(502).end();
    }
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const subpath = `http://127.0.0.1:${proxy.address().port}/long-exposure-camera/`;
  const subContext = await browser.newContext();
  const subPage = await subContext.newPage();
  watchErrors(subPage);
  await subPage.goto(subpath);
  await subPage.waitForFunction(() => navigator.serviceWorker.controller !== null);
  assert.equal(await subPage.evaluate(async () => (await navigator.serviceWorker.ready).scope), subpath);
  const manifest = await subPage.evaluate(async () => {
    const url = document.querySelector('link[rel="manifest"]').href;
    const data = await (await fetch(url)).json();
    return [new URL(data.start_url, url).href, new URL(data.scope, url).href];
  });
  assert.deepEqual(manifest, [subpath, subpath]);
  await subContext.setOffline(true);
  await subPage.reload();
  await subPage.locator('#enable').waitFor();
  assert.equal(await subPage.locator('#shutter').isDisabled(), true);
  assert.match(await subPage.title(), /Still/);
  console.log('PASS PWA: GitHub Pages-style subpath assets, manifest scope and offline reload');
  await context.close();
  await subContext.close();
  await checkUpgradedUX({ browser, origin, watchErrors });
  assert.deepEqual(errors, [], 'Unexpected browser JavaScript or console errors');
  console.log('PASS all browser checks (Chromium emulation; not a real iPhone/Safari test)');
} finally {
  await browser?.close();
  if (proxy) {
    proxy.closeAllConnections();
    await new Promise(resolve => proxy.close(resolve));
  }
  if (server.exitCode === null) {
    const exit = once(server, 'exit');
    server.kill();
    await exit;
  }
}
