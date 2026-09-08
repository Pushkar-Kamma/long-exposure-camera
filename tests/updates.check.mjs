import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const legacyHTML = `<!doctype html><html><head><title>Legacy Still</title></head><body>
<h1 id="legacyApp">Old camera without Moon lab</h1>
<script>navigator.serviceWorker.getRegistration('./').then(reg => reg || navigator.serviceWorker.register('./sw.js'));</script>
</body></html>`;
const legacyWorker = `
const CACHE = 'still-camera-v2';
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(['./', './index.html']))));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.method === 'GET') event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});
`;

async function fixtureServer(origin) {
  const state = { legacy: true, release: 104, waiting: false, failManifest: false, failAsset: null, requests: [] };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    state.requests.push({ path: url.pathname, search: url.search, cacheControl: request.headers['cache-control'] || '', release: state.release });
    if (url.pathname === '/other/sw.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' });
      response.end(`self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));`);
      return;
    }
    if (!url.pathname.startsWith('/still/')) { response.writeHead(404).end(); return; }
    const path = url.pathname.slice('/still'.length);
    if ((path === '/app-assets.json' && state.failManifest) || path === state.failAsset) {
      response.writeHead(503, { 'Cache-Control': 'no-store' }).end('Injected repair network failure');
      return;
    }
    try {
      if (state.legacy && ['/', '/index.html'].includes(path)) {
        response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=3600' }).end(legacyHTML);
        return;
      }
      if (state.legacy && path === '/sw.js') {
        response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' }).end(legacyWorker);
        return;
      }
      const upstream = await fetch(`${origin}${path}${url.search}`, { cache: 'no-store' });
      let body = Buffer.from(await upstream.arrayBuffer());
      if (path === '/sw.js') {
        let worker = body.toString().replace(/const CACHE = 'still-camera-v\d+';/, `const CACHE = 'still-camera-v${state.release}';`);
        if (state.waiting) worker = worker.replace('await self.skipWaiting();', '');
        body = Buffer.from(worker);
      } else if (['/', '/index.html'].includes(path)) {
        body = Buffer.from(body.toString().replace('</head>', `<meta name="test-release" content="${state.release}"></head>`));
      }
      response.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('Content-Type'),
        'Cache-Control': path === '/sw.js' ? 'no-cache' : 'public, max-age=3600'
      });
      response.end(body);
    } catch (error) {
      response.writeHead(502).end(error.message);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    state, root: `http://127.0.0.1:${server.address().port}/still/`,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  };
}

export async function runUpdateChecks({ browser, origin }) {
  const fixture = await fixtureServer(origin);
  const contexts = [];
  const errors = [];
  const newContext = async () => {
    const context = await browser.newContext({ permissions: ['camera'], viewport: { width: 393, height: 852 } });
    await context.addInitScript(() => {
      if (!globalThis.ServiceWorkerContainer) return;
      const register = ServiceWorkerContainer.prototype.register;
      globalThis.testWorkerRegistrations = [];
      ServiceWorkerContainer.prototype.register = function (url, options) {
        globalThis.testWorkerRegistrations.push({ url: new URL(url, location.href).href, ...options });
        return register.call(this, url, options);
      };
    });
    contexts.push(context);
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    return context;
  };
  const seed = page => page.evaluate(async () => {
    const { savePhoto, makeThumbnail } = await import('./gallery.js');
    const { savePreferences } = await import('./preferences.js');
    const canvas = document.createElement('canvas');
    canvas.width = 8; canvas.height = 6;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#536b8a'; ctx.fillRect(0, 0, 8, 6);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg'));
    ctx.fillStyle = '#ab734d'; ctx.fillRect(0, 0, 4, 3);
    const referenceBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg'));
    await savePhoto({
      id: 'repair-preserved-photo', name: 'synthetic-preserved.jpg', createdAt: 20260908,
      blob, referenceBlob, width: 8, height: 6, mode: 'moon', simulated: true,
      source: 'simulation', framesUsed: 1, actual: 1, requested: 1, outcome: 'complete'
    }, await makeThumbnail(blob));
    savePreferences({ duration: 45, mode: 'trails', delay: '5', quality: '720' });
    localStorage.setItem('unrelated-preference', 'must-survive');
    for (const name of ['unrelated-app-v1', 'still-camera-not-versioned']) {
      const cache = await caches.open(name);
      await cache.put(new URL('unrelated-data', location.href), new Response('must-survive'));
    }
    await navigator.serviceWorker.register('/other/sw.js', { scope: '/other/' });
    const digest = async data => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await data.arrayBuffer()))].join(',');
    return { photo: await digest(blob), reference: await digest(referenceBlob) };
  });
  const preserved = (page, expected) => page.evaluate(async expected => {
    const { getPhoto, listPhotos } = await import('./gallery.js');
    const { loadPreferences } = await import('./preferences.js');
    const photo = await getPhoto('repair-preserved-photo');
    const digest = async data => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await data.arrayBuffer()))].join(',');
    return {
      photo: await digest(photo.blob) === expected.photo,
      reference: await digest(photo.referenceBlob) === expected.reference,
      preferences: loadPreferences(),
      unrelatedPreference: localStorage.getItem('unrelated-preference'),
      caches: (await caches.keys()).filter(name => ['unrelated-app-v1', 'still-camera-not-versioned'].includes(name)).sort(),
      otherWorker: (await navigator.serviceWorker.getRegistrations()).some(reg => reg.scope.endsWith('/other/')),
      count: (await listPhotos()).total
    };
  }, expected);
  const assertPreserved = async (page, expected) => {
    assert.deepEqual(await preserved(page, expected), {
      photo: true, reference: true, preferences: { duration: 45, mode: 'trails', delay: '5', quality: '720' },
      unrelatedPreference: 'must-survive', caches: ['still-camera-not-versioned', 'unrelated-app-v1'], otherWorker: true, count: 1
    });
  };
  const currentRoot = async page => {
    await page.waitForURL(fixture.root, { timeout: 30000 });
    await page.locator('#moonOpen').waitFor({ state: 'visible' });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  };
  const repair = async (page, oldPage) => {
    await page.click('#refreshStart');
    await page.waitForFunction(() => document.querySelector('#moonOpen') || !document.querySelector('#refreshError')?.hidden, { timeout: 30000 });
    if (await page.locator('#refreshError').isVisible()) {
      assert.match(await page.locator('#refreshError').textContent(), /old worker active|Close other Still windows/);
      if (oldPage && !oldPage.isClosed()) await oldPage.close();
      await page.click('#refreshStart');
    }
    await currentRoot(page);
  };
  try {
    const context = await newContext();
    const oldPage = await context.newPage();
    await oldPage.goto(fixture.root);
    await oldPage.waitForFunction(() => navigator.serviceWorker.controller !== null);
    const original = await seed(oldPage);
    await oldPage.reload();
    assert.equal(await oldPage.locator('#moonOpen').count(), 0);
    assert.equal(await oldPage.locator('#legacyApp').isVisible(), true);
    fixture.state.legacy = false;
    await oldPage.reload();
    assert.equal(await oldPage.locator('#legacyApp').isVisible(), true, 'Reproduce mobile bug: legacy cache serves old markup after the network release changes');
    assert.equal(await oldPage.locator('#moonOpen').count(), 0);
    const refreshPage = await context.newPage();
    await refreshPage.goto(`${fixture.root}refresh.html`);
    await refreshPage.locator('#refreshStart').waitFor();
    const requestsBeforeRepair = fixture.state.requests.length;
    await repair(refreshPage, oldPage);
    assert.equal(new URL(refreshPage.url()).search, '', 'Repair returns to a canonical URL without a cache-busting root query');
    await refreshPage.click('#moonOpen');
    await refreshPage.locator('#moonDialog').waitFor({ state: 'visible' });
    await refreshPage.click('#moonClose');
    await assertPreserved(refreshPage, original);
    assert.ok(await refreshPage.evaluate(() => globalThis.testWorkerRegistrations.some(registration =>
      registration.url === new URL('./sw.js', location.href).href && registration.updateViaCache === 'none'
    )), 'App registration explicitly bypasses the worker HTTP cache');
    const installedFiles = await refreshPage.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      const manifest = await (await fetch('./app-assets.json')).json();
      const cache = await caches.open('still-camera-v104');
      return Promise.all([...manifest.assets, './app-assets.json'].map(async asset => Boolean(await cache.match(new URL(asset, registration.scope)))));
    });
    assert.ok(installedFiles.every(Boolean), 'Current version cache contains every manifest asset, including Moon modules');
    const repairRequests = fixture.state.requests.slice(requestsBeforeRepair);
    assert.ok(repairRequests.some(request => request.path === '/still/app-assets.json' && request.search.startsWith('?refresh=')), 'Repair verifies a cache-busted manifest');
    assert.ok(repairRequests.some(request => request.path === '/still/moon-ui.js' && !request.search), 'Canonical Moon assets are downloaded');
    assert.ok(repairRequests.some(request => request.path === '/still/sw.js'), 'Current worker script is warmed');
    if (!oldPage.isClosed()) await oldPage.close();
    await context.setOffline(true);
    await refreshPage.reload();
    await refreshPage.locator('#moonOpen').waitFor();
    await assertPreserved(refreshPage, original);
    await context.setOffline(false);
    console.log('PASS repair: reproduced legacy cached root, restored canonical/offline Moon app, preserved JPEG/reference/settings and unrelated cache/worker');

    const failures = await newContext();
    fixture.state.legacy = true;
    const stale = await failures.newPage();
    await stale.goto(fixture.root);
    await stale.waitForFunction(() => navigator.serviceWorker.controller !== null);
    const failureOriginal = await seed(stale);
    fixture.state.legacy = false;
    const failurePage = await failures.newPage();
    await failurePage.goto(`${fixture.root}refresh.html?finish=1`);
    await failurePage.locator('#refreshError').waitFor({ state: 'visible' });
    assert.match(await failurePage.locator('#refreshError').textContent(), /old worker active.*Close other Still windows/);
    await assertPreserved(failurePage, failureOriginal);
    await failurePage.goto(`${fixture.root}refresh.html`);
    await failures.setOffline(true);
    await failurePage.click('#refreshStart');
    await failurePage.locator('#refreshError').waitFor({ state: 'visible' });
    assert.match(await failurePage.locator('#refreshError').textContent(), /Refresh could not finish.*gallery and settings have not been cleared/);
    await failures.setOffline(false);
    await assertPreserved(failurePage, failureOriginal);
    fixture.state.failManifest = true;
    await failurePage.click('#refreshStart');
    await failurePage.locator('#refreshError').waitFor({ state: 'visible' });
    assert.match(await failurePage.locator('#refreshError').textContent(), /HTTP 503/);
    assert.equal(await failurePage.locator('#refreshStart').isEnabled(), true);
    await assertPreserved(failurePage, failureOriginal);
    fixture.state.failManifest = false;
    fixture.state.failAsset = '/moon-ui.js';
    await failurePage.click('#refreshStart');
    await failurePage.waitForURL(/refresh\.html\?finish=1/);
    await failurePage.locator('#refreshError').waitFor({ state: 'visible' });
    const phaseFailure = await failurePage.locator('#refreshError').textContent();
    assert.match(phaseFailure, /HTTP 503|old worker active/);
    fixture.state.failAsset = null;
    await assertPreserved(failurePage, failureOriginal);
    if (!stale.isClosed()) await stale.close();
    await repair(failurePage);
    await assertPreserved(failurePage, failureOriginal);
    console.log('PASS repair failures: refuses legacy controller, offline/HTTP errors are explicit, data remains intact and retry succeeds');
    await failures.close();

    const updates = await newContext();
    const app = await updates.newPage();
    await app.goto(fixture.root);
    await app.waitForFunction(() => navigator.serviceWorker.controller !== null);
    assert.equal(await app.locator('#updateBanner').isVisible(), false, 'Initial worker activation is not an update');
    await app.click('#settingsToggle');
    await app.fill('#duration', '600');
    await app.selectOption('#delay', '0');
    await app.selectOption('#quality', '720');
    await app.click('#enable');
    await app.waitForFunction(() => document.body.dataset.phase === 'ready');
    await app.click('#shutter');
    await app.waitForFunction(() => !document.querySelector('#finish').disabled);
    const documentToken = await app.evaluate(() => { globalThis.testDocumentToken = crypto.randomUUID(); return globalThis.testDocumentToken; });
    const updateTo = async (release, waiting = false) => {
      fixture.state.release = release;
      fixture.state.waiting = waiting;
      await app.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
      await app.locator('#updateBanner').waitFor({ state: 'visible', timeout: 30000 });
      await app.waitForFunction(({ release, waiting }) => navigator.serviceWorker.getRegistration().then(registration => {
        if (waiting) return Boolean(registration.waiting);
        return caches.has(`still-camera-v${release}`).then(exists => exists && !registration.installing && !registration.waiting);
      }), { release, waiting });
    };
    await updateTo(105);
    assert.equal(await app.evaluate(() => globalThis.testDocumentToken), documentToken);
    assert.equal(await app.locator('body').getAttribute('data-phase'), 'capturing');
    assert.equal(await app.locator('#video').evaluate(video => video.srcObject.getVideoTracks()[0].readyState), 'live');
    await app.click('#applyUpdate');
    assert.match(await app.locator('#notice').textContent(), /Finish or cancel.*save before updating/);
    assert.equal(await app.evaluate(() => globalThis.testDocumentToken), documentToken);
    assert.equal(await app.locator('body').getAttribute('data-phase'), 'capturing');
    await app.click('#cancel');
    await app.waitForFunction(() => document.body.dataset.phase === 'ready');
    await Promise.all([app.waitForNavigation({ waitUntil: 'load' }), app.click('#applyUpdate')]);
    assert.equal(await app.locator('meta[name="test-release"]').getAttribute('content'), '105');
    assert.equal(await app.locator('#updateBanner').isVisible(), false);
    console.log('PASS controller replacement: running capture/track survives, visible Update app blocks with notice, user updates safely after cancel');

    await app.click('#settingsToggle');
    await app.fill('#duration', '1');
    await app.selectOption('#delay', '0');
    await app.evaluate(() => {
      globalThis.testFailSave = true;
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (globalThis.testFailSave && this.name === 'entries') throw new DOMException('Synthetic unsaved photo', 'QuotaExceededError');
        return put.apply(this, args);
      };
    });
    await app.click('#enable');
    await app.waitForFunction(() => document.body.dataset.phase === 'ready');
    await app.click('#shutter');
    await app.locator('#photoStorage[data-state="failed"]').waitFor();
    const unsaved = await app.evaluate(() => ({
      url: document.querySelector('#download').href,
      token: (globalThis.testDocumentToken = crypto.randomUUID())
    }));
    await updateTo(106);
    assert.equal(await app.evaluate(() => globalThis.testDocumentToken), unsaved.token);
    assert.equal(await app.locator('#download').getAttribute('href'), unsaved.url);
    assert.equal(await app.locator('#share').isEnabled(), true);
    await app.click('#applyUpdate');
    assert.match(await app.locator('#notice').textContent(), /Finish or cancel.*save before updating/);
    assert.equal(await app.evaluate(() => globalThis.testDocumentToken), unsaved.token);
    assert.equal(await app.locator('#result').isVisible(), true);
    await app.evaluate(() => { globalThis.testFailSave = false; });
    await app.click('#retryStorage');
    await app.locator('#photoStorage[data-state="saved"]').waitFor();
    await Promise.all([app.waitForNavigation({ waitUntil: 'load' }), app.click('#applyUpdate')]);
    assert.equal(await app.locator('meta[name="test-release"]').getAttribute('content'), '106');
    await app.waitForFunction(() => document.querySelector('#galleryCount').textContent === '1');
    await updateTo(107, true);
    assert.equal(await app.locator('meta[name="test-release"]').getAttribute('content'), '106');
    await Promise.all([app.waitForNavigation({ waitUntil: 'load' }), app.click('#applyUpdate')]);
    assert.equal(await app.locator('meta[name="test-release"]').getAttribute('content'), '107');
    await app.waitForFunction(() => document.querySelector('#galleryCount').textContent === '1');
    assert.deepEqual(errors, [], 'No unexpected JavaScript errors during repair or updates');
    console.log('PASS update safety: unsaved JPEG survives replacement, save gate blocks reload, safe reload and explicit waiting-worker activation preserve gallery');
  } finally {
    await Promise.all(contexts.map(context => context.close()));
    await fixture.close();
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
    await runUpdateChecks({ browser, origin });
    console.log('PASS focused legacy-cache repair and safe-update browser regressions');
  } finally {
    await browser?.close();
    if (server.exitCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
  }
}
