const base = new URL('./', location.href);
const status = document.getElementById('refreshStatus');
const button = document.getElementById('refreshStart');
const error = document.getElementById('refreshError');

async function download(url, json = false) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { cache: 'reload', signal: controller.signal });
    if (!response.ok) throw new Error(`An app file could not be downloaded (HTTP ${response.status}). Check your connection and retry.`);
    return json ? await response.json() : await response.arrayBuffer();
  } catch (cause) {
    if (controller.signal.aborted) throw new Error('The app download timed out. Check your connection and retry.');
    throw cause;
  } finally {
    clearTimeout(timeout);
  }
}

async function assets() {
  const url = new URL('app-assets.json', base);
  url.searchParams.set('refresh', String(Date.now()));
  const manifest = await download(url, true);
  if (!Array.isArray(manifest.assets) || !manifest.assets.length) throw new Error('The app file list is unavailable. Try again later.');
  return [...manifest.assets, './app-assets.json', './sw.js'].map(path => {
    if (typeof path !== 'string') throw new Error('Invalid app file list.');
    const url = new URL(path, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.search || url.hash) {
      throw new Error('The app file list includes a file outside this app. Refresh stopped.');
    }
    return url.href;
  });
}

function failed(cause) {
  error.textContent = `Refresh could not finish: ${cause.message} Your gallery and settings have not been cleared.`;
  error.hidden = false;
  button.disabled = false;
  button.textContent = 'Retry refresh';
}

async function start() {
  button.disabled = true;
  error.hidden = true;
  status.textContent = 'Checking the latest release...';
  await assets();
  if ('serviceWorker' in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const registration of registrations) {
      if (registration.scope === base.href) await registration.unregister();
    }
  }
  // Only Still's versioned application caches are removed, never IndexedDB or localStorage.
  if ('caches' in window) {
    for (const key of await caches.keys()) {
      if (/^still-camera-v\d+$/.test(key)) await caches.delete(key);
    }
  }
  status.textContent = 'Old app files released. Opening a fresh loading page...';
  const next = new URL('refresh.html', base);
  next.searchParams.set('finish', '1');
  next.searchParams.set('at', String(Date.now()));
  location.replace(next.href);
}

async function finish() {
  button.disabled = true;
  status.textContent = 'Downloading the latest app files. Your photos stay on this device...';
  const controller = navigator.serviceWorker?.controller;
  if (controller && new URL(controller.scriptURL).pathname.startsWith(base.pathname)) {
    throw new Error('Another Still window is keeping the old worker active. Close other Still windows, then tap Retry refresh.');
  }
  const urls = await assets();
  for (let index = 0; index < urls.length; index++) {
    await download(urls[index]);
    status.textContent = `Loaded ${index + 1} of ${urls.length} app files...`;
  }
  location.replace(base.href);
}

button.addEventListener('click', () => { void start().catch(failed); });
if (new URL(location.href).searchParams.get('finish') === '1') void finish().catch(failed);
