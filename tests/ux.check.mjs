import assert from 'node:assert/strict';

export async function checkUpgradedUX({ browser, origin, watchErrors }) {
  const context = await browser.newContext({ permissions: ['camera'], viewport: { width: 393, height: 852 } });
  const page = await context.newPage();
  watchErrors(page);
  const settings = async target => {
    if (!await target.locator('#settingsPanel').evaluate(panel => panel.open)) await target.click('#settingsToggle');
    await target.locator('#duration').waitFor({ state: 'visible' });
  };
  const ready = async target => target.waitForFunction(() => document.body.dataset.phase === 'ready');
  const saved = async target => {
    await target.locator('#photoStorage[data-state="saved"]').waitFor();
    assert.equal(await target.locator('#share').isEnabled(), true);
    assert.equal(await target.locator('#download').isVisible(), true);
  };
  const readSettings = target => target.evaluate(() => ({
    duration: document.querySelector('#duration').value,
    mode: document.querySelector('input[name="mode"]:checked').value,
    delay: document.querySelector('#delay').value,
    quality: document.querySelector('#quality').value
  }));
  const list = target => target.evaluate(async () => {
    const { listPhotos } = await import('./gallery.js');
    const { entries, total } = await listPhotos();
    return { entries: entries.map(({ thumbnail, ...metadata }) => metadata), total };
  });
  const digestLink = (target, selector) => target.locator(selector).evaluate(async link => {
    const blob = await (await fetch(link.href)).blob();
    const bytes = await blob.arrayBuffer();
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return { digest, size: blob.size, type: blob.type, name: link.download };
  });
  const navigationPrevented = target => target.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  const assertDock = async (target, button) => {
    const boxes = await target.evaluate(selector => {
      const rect = element => {
        const r = element.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height, hittable: element.contains(hit) };
      };
      const dock = document.querySelector('#shootingDock');
      return { dock: rect(dock), button: rect(document.querySelector(selector)), position: getComputedStyle(dock).position, width: innerWidth, height: innerHeight };
    }, button);
    assert.equal(boxes.position, 'fixed');
    for (const box of [boxes.dock, boxes.button]) {
      assert.ok(box.width > 0 && box.height > 0 && box.x >= -1 && box.y >= 0 && box.right <= boxes.width + 1 && box.bottom <= boxes.height + 1, `Dock/button outside viewport: ${JSON.stringify(boxes)}`);
    }
    assert.equal(boxes.button.hittable, true, 'Fixed shutter is unobstructed and tappable');
  };
  try {
    await page.goto(origin);
    assert.equal(await page.locator('#settingsPanel').evaluate(panel => panel.open), false);
    assert.equal(await page.locator('#duration').isVisible(), false);
    await settings(page);
    await page.fill('#duration', '45');
    await page.check('input[value="trails"]');
    await page.selectOption('#delay', '5');
    await page.selectOption('#quality', '720');
    assert.match(await page.locator('#preferencesStatus').textContent(), /remembered/);
    await page.reload();
    assert.deepEqual(await readSettings(page), { duration: '45', mode: 'trails', delay: '5', quality: '720' });
    assert.match(await page.locator('#settingsSummary').textContent(), /45s.*Light trails/);
    assert.equal(await page.locator('#settingsPanel').evaluate(panel => panel.open), false);
    for (const corrupt of ['{broken', JSON.stringify({ duration: 601, mode: 'trails', delay: '5', quality: '720' })]) {
      await page.evaluate(async value => {
        const { PREFERENCES_KEY } = await import('./preferences.js');
        localStorage.setItem(PREFERENCES_KEY, value);
      }, corrupt);
      await page.reload();
      assert.deepEqual(await readSettings(page), { duration: '10', mode: 'average', delay: '3', quality: '1080' });
      assert.match(await page.locator('#preferencesStatus').textContent(), /could not be loaded.*Default settings/);
      assert.equal(await page.locator('#enable').isEnabled(), true);
    }
    console.log('PASS preferences UI: all four settings survive reload; corrupt/invalid storage warns and restores defaults');

    for (const viewport of [{ width: 393, height: 852 }, { width: 320, height: 568 }]) {
      await page.setViewportSize(viewport);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await assertDock(page, '#enable');
    }
    await settings(page);
    await page.fill('#duration', '1');
    await page.selectOption('#delay', '0');
    await page.selectOption('#quality', '720');
    await page.click('#enable');
    await ready(page);
    assert.equal(await page.locator('#enable').isVisible(), false);
    for (const viewport of [{ width: 393, height: 852 }, { width: 320, height: 568 }]) {
      await page.setViewportSize(viewport);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await assertDock(page, '#shutter');
    }
    await page.setViewportSize({ width: 393, height: 852 });
    await page.click('#shutter');
    await saved(page);
    assert.equal(await navigationPrevented(page), false);
    const initial = await list(page);
    assert.equal(initial.total, 1);
    const id = initial.entries[0].id;
    assert.equal(initial.entries[0].exposure, 0);
    assert.equal(initial.entries[0].outcome, 'complete');
    assert.equal(initial.entries[0].width, 1280);
    assert.equal(initial.entries[0].height, 720);
    await page.locator('#ev').evaluate(input => {
      for (const value of ['-1', '2', '0.3', '1.5', '-0.5']) {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    assert.equal(await navigationPrevented(page), true, 'Latest unsaved brightness must protect navigation');
    await saved(page);
    assert.equal(await navigationPrevented(page), false);
    const updated = await list(page);
    assert.equal(updated.total, 1);
    assert.equal(updated.entries[0].id, id);
    assert.equal(updated.entries[0].exposure, -0.5);
    const finalJPEG = await digestLink(page, '#download');
    const stored = await page.evaluate(async id => {
      const { getPhoto } = await import('./gallery.js');
      const photo = await getPhoto(id);
      const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', await photo.blob.arrayBuffer()));
      return { id: photo.id, exposure: photo.exposure, digest: [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join(''), size: photo.blob.size };
    }, id);
    assert.equal(stored.exposure, -0.5);
    assert.equal(stored.digest, finalJPEG.digest);
    assert.equal(stored.size, finalJPEG.size);
    console.log('PASS compact dock at 393x852 and 320x568; auto-save and rapid brightness updates retain one latest photo');

    await page.click('#resultGallery');
    await page.locator(`.gallery-card[data-photo-id="${id}"]`).click();
    await page.locator('#galleryViewer').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#galleryImage').naturalWidth === 1280);
    assert.deepEqual(await digestLink(page, '#galleryDownload'), finalJPEG);
    assert.match(await page.locator('#galleryDetails').textContent(), /1280 x 720.*Smooth motion/);
    await page.click('#galleryClose');
    assert.equal(await page.locator('#galleryDialog').isVisible(), false);
    await page.waitForFunction(() => !document.querySelector('#galleryImage').hasAttribute('src'));
    assert.equal(await page.locator('#galleryImage').getAttribute('src'), null);
    await page.click('#resultGallery');
    await page.locator('.gallery-card').waitFor();
    assert.equal(await page.locator('#galleryViewer').isVisible(), false);
    await page.click('#galleryClose');
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await context.setOffline(true);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#galleryCount').textContent === '1');
    await page.click('#galleryOpen');
    await page.locator(`.gallery-card[data-photo-id="${id}"]`).click();
    await page.locator('#galleryViewer').waitFor({ state: 'visible' });
    assert.deepEqual(await digestLink(page, '#galleryDownload'), finalJPEG);
    page.once('dialog', dialog => dialog.dismiss());
    await page.click('#galleryDelete');
    assert.equal(await page.locator('#galleryViewer').isVisible(), true);
    assert.equal((await list(page)).total, 1);
    page.once('dialog', dialog => dialog.accept());
    await page.click('#galleryDelete');
    await page.waitForFunction(() => document.querySelector('#galleryCount').textContent === '0');
    const deleted = await page.evaluate(async id => {
      const { getPhoto, listPhotos } = await import('./gallery.js');
      const { total } = await listPhotos();
      try { await getPhoto(id); return { total, missing: false }; }
      catch (error) { return { total, missing: /no longer/.test(error.message) }; }
    }, id);
    assert.deepEqual(deleted, { total: 0, missing: true });
    await page.click('#galleryClose');
    await context.setOffline(false);
    console.log('PASS gallery viewer/download equality, close/reopen, offline persistence, dismissed and confirmed deletion');

    const storageChecks = await page.evaluate(async () => {
      const { savePhoto, listPhotos, getPhoto, deletePhoto, makeThumbnail } = await import('./gallery.js');
      const check = (condition, label) => { if (!condition) throw new Error(label); };
      const canvas = document.createElement('canvas');
      canvas.width = 480;
      canvas.height = 240;
      canvas.getContext('2d').fillRect(0, 0, 480, 240);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg'));
      const thumbnail = await makeThumbnail(blob);
      const bitmap = await createImageBitmap(thumbnail);
      check(bitmap.width === 240 && bitmap.height === 120, 'Thumbnail bounded to 240px and preserves aspect ratio');
      bitmap.close();
      const sample = { id: 'synthetic-0', createdAt: 1000, name: 'synthetic.jpg', blob, actual: 1, requested: 1, mode: 'average', outcome: 'complete', exposure: 0, width: 480, height: 240 };
      for (let index = 0; index < 25; index++) await savePhoto({ ...sample, id: `synthetic-${index}`, createdAt: 1000 + index }, thumbnail);
      for (const limit of [12, 24, 36]) {
        const { entries, total } = await listPhotos(limit);
        check(total === 25 && entries.length === Math.min(limit, 25), `Pagination limit ${limit}`);
        check(entries.every((entry, index) => entry.id === `synthetic-${24 - index}`), 'Newest-first pagination order');
        check(entries.every(entry => !('blob' in entry) && entry.thumbnail instanceof Blob), 'Index entries have thumbnails, not full JPEG blobs');
      }
      await savePhoto({ ...sample, exposure: 2 }, thumbnail);
      check((await listPhotos()).total === 25 && (await getPhoto(sample.id)).exposure === 2, 'Updating same ID replaces rather than duplicates');
      let validationRejected = false;
      try { await savePhoto({ id: 'invalid', blob: null }, thumbnail); }
      catch { validationRejected = true; }
      check(validationRejected, 'Reject invalid photo before storage');
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'entries') throw new DOMException('Injected thumbnail quota error', 'QuotaExceededError');
        return original.apply(this, args);
      };
      let failed = false;
      try { await savePhoto({ ...sample, id: 'must-rollback' }, thumbnail); }
      catch (error) { failed = error.name === 'QuotaExceededError'; }
      finally { IDBObjectStore.prototype.put = original; }
      check(failed, 'Quota failure reaches caller');
      let missing = false;
      try { await getPhoto('must-rollback'); } catch { missing = true; }
      check(missing && (await listPhotos()).total === 25, 'Both photo and entry roll back atomically');
      const originalDelete = IDBObjectStore.prototype.delete;
      IDBObjectStore.prototype.delete = function (...args) {
        if (this.name === 'entries') throw new DOMException('Injected second-store deletion failure', 'UnknownError');
        return originalDelete.apply(this, args);
      };
      let deleteFailed = false;
      try { await deletePhoto(sample.id); }
      catch (error) { deleteFailed = error.name === 'UnknownError'; }
      finally { IDBObjectStore.prototype.delete = originalDelete; }
      check(deleteFailed, 'Synchronous second-store deletion failure reaches caller');
      check((await getPhoto(sample.id)).id === sample.id && (await listPhotos()).total === 25, 'Failed deletion retains both the photo and its entry');
      const keys = await new Promise((resolve, reject) => {
        const request = indexedDB.open('still-camera-gallery', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction(['photos', 'entries'], 'readonly');
          const photos = transaction.objectStore('photos').getAllKeys();
          const entries = transaction.objectStore('entries').getAllKeys();
          transaction.oncomplete = () => { db.close(); resolve({ photos: photos.result, entries: entries.result }); };
          transaction.onabort = () => { db.close(); reject(transaction.error); };
        };
      });
      check(keys.photos.length === 25 && JSON.stringify(keys.photos) === JSON.stringify(keys.entries), 'Raw IndexedDB stores contain identical keys and no orphan photos or entries');
      await deletePhoto('synthetic-0');
      check((await listPhotos()).total === 24, 'Delete decreases metadata count');
      await savePhoto(sample, thumbnail);
      return { total: (await listPhotos()).total, thumbnailBytes: thumbnail.size };
    });
    assert.equal(storageChecks.total, 25);
    await page.click('#galleryOpen');
    await page.waitForFunction(() => document.querySelectorAll('.gallery-card').length === 12);
    assert.equal(await page.locator('#galleryMore').isVisible(), true);
    await page.click('#galleryMore');
    await page.waitForFunction(() => document.querySelectorAll('.gallery-card').length === 24);
    await page.click('#galleryMore');
    await page.waitForFunction(() => document.querySelectorAll('.gallery-card').length === 25);
    assert.equal(await page.locator('#galleryMore').isVisible(), false);
    await page.click('#galleryClose');
    await page.click('#galleryOpen');
    await page.waitForFunction(() => document.querySelectorAll('.gallery-card').length === 12);
    await page.click('#galleryClose');
    console.log('PASS real IndexedDB: 25-photo pagination, metadata-only list, thumbnail sizing, replacement and atomic quota rollback');
  } finally {
    await context.close();
  }

  const failureContext = await browser.newContext({ permissions: ['camera'], viewport: { width: 393, height: 852 } });
  await failureContext.addInitScript(() => {
    const open = IDBFactory.prototype.open;
    globalThis.failGalleryOpen = true;
    IDBFactory.prototype.open = function (...args) {
      if (globalThis.failGalleryOpen) throw new DOMException('Injected storage access failure', 'SecurityError');
      return open.apply(this, args);
    };
  });
  const failurePage = await failureContext.newPage();
  watchErrors(failurePage);
  try {
    await failurePage.goto(origin);
    await failurePage.waitForFunction(() => document.querySelector('#galleryCount').textContent === '!');
    await failurePage.click('#galleryOpen');
    await failurePage.locator('#galleryRetry').waitFor();
    assert.match(await failurePage.locator('#galleryStatus').textContent(), /Gallery unavailable.*Injected storage access failure/);
    await failurePage.evaluate(() => { globalThis.failGalleryOpen = false; });
    await failurePage.click('#galleryRetry');
    await failurePage.waitForFunction(() => document.querySelector('#galleryCount').textContent === '0');
    await failurePage.click('#galleryClose');
    await failurePage.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      globalThis.failGalleryPut = true;
      IDBObjectStore.prototype.put = function (...args) {
        if (globalThis.failGalleryPut && this.name === 'entries') throw new DOMException('Injected storage quota failure', 'QuotaExceededError');
        return put.apply(this, args);
      };
    });
    await settings(failurePage);
    await failurePage.fill('#duration', '1');
    await failurePage.selectOption('#delay', '0');
    await failurePage.selectOption('#quality', '720');
    await failurePage.click('#enable');
    await ready(failurePage);
    await failurePage.click('#shutter');
    await failurePage.locator('#photoStorage[data-state="failed"]').waitFor();
    assert.match(await failurePage.locator('#photoStorage').textContent(), /Not saved.*Injected storage quota failure.*Save \/ Share or Download JPEG/);
    assert.equal(await failurePage.locator('#share').isEnabled(), true);
    assert.equal(await failurePage.locator('#download').isVisible(), true);
    const availableJPEG = await digestLink(failurePage, '#download');
    assert.equal(availableJPEG.type, 'image/jpeg');
    assert.ok(availableJPEG.size > 1000);
    assert.equal((await list(failurePage)).total, 0);
    assert.equal(await navigationPrevented(failurePage), true);
    let warning = '';
    failurePage.once('dialog', async dialog => { warning = dialog.message(); await dialog.dismiss(); });
    await failurePage.click('#again');
    assert.match(warning, /not saved.*Discard/);
    assert.equal(await failurePage.locator('#result').isVisible(), true);
    assert.deepEqual(await digestLink(failurePage, '#download'), availableJPEG);
    await failurePage.evaluate(() => { globalThis.failGalleryPut = false; });
    await failurePage.click('#retryStorage');
    await saved(failurePage);
    assert.equal((await list(failurePage)).total, 1);
    assert.equal(await navigationPrevented(failurePage), false);
    assert.deepEqual(await digestLink(failurePage, '#download'), availableJPEG);
    await failurePage.click('#again');
    await ready(failurePage);
    console.log('PASS storage failures: unavailable-gallery warning/retry, quota-safe export, unsaved confirmation, navigation protection and save retry');
    await failurePage.evaluate(() => { globalThis.failGalleryPut = true; });
    await failurePage.click('#shutter');
    await failurePage.locator('#photoStorage[data-state="failed"]').waitFor();
    const beforeContextLoss = await digestLink(failurePage, '#download');
    await failurePage.locator('#output').evaluate(canvas => new Promise((resolve, reject) => {
      const extension = canvas.getContext('webgl2').getExtension('WEBGL_lose_context');
      if (!extension) { reject(new Error('Cannot simulate GPU context loss')); return; }
      canvas.addEventListener('webglcontextlost', () => resolve(), { once: true });
      extension.loseContext();
    }));
    assert.match(await failurePage.locator('#notice').textContent(), /Graphics memory was released.*Save the existing photo/);
    assert.equal(await failurePage.locator('#share').isEnabled(), true);
    assert.deepEqual(await digestLink(failurePage, '#download'), beforeContextLoss);
    await failurePage.evaluate(() => { globalThis.failGalleryPut = false; });
    await failurePage.click('#retryStorage');
    await saved(failurePage);
    assert.equal((await list(failurePage)).total, 2);
    assert.deepEqual(await digestLink(failurePage, '#download'), beforeContextLoss);
    assert.equal(await failurePage.locator('#error').isVisible(), false);
    assert.equal(await navigationPrevented(failurePage), false);
    console.log('PASS lost-GPU retry: existing encoded JPEG saves successfully without rerendering or changing download bytes');
  } finally {
    await failureContext.close();
  }
}
