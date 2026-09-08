export async function setupUpdates({ canReload, onBlocked }) {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    document.getElementById('offline').textContent = 'Offline installation is unavailable in this browser.';
    return;
  }
  const banner = document.getElementById('updateBanner');
  const message = document.getElementById('updateMessage');
  const button = document.getElementById('applyUpdate');
  let requested = false;
  let reloadReady = false;
  let applying = null;
  let registration;
  let hadController = Boolean(navigator.serviceWorker.controller);

  const offerUpdate = () => {
    banner.hidden = false;
    message.textContent = 'A newer Still is ready. Finish your capture and save any unfinished result, then update.';
  };
  const resetButton = () => {
    clearTimeout(applying);
    applying = null;
    button.disabled = false;
    button.textContent = 'Update app';
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    const replacingController = hadController;
    hadController = true;
    if (!replacingController && !requested) return;
    reloadReady = true;
    resetButton();
    if (requested && canReload()) location.reload();
    else if (requested) {
      offerUpdate();
      onBlocked('The update is ready. Finish your capture or save the current result before reloading.');
    } else offerUpdate();
  });
  button.addEventListener('click', () => {
    if (!canReload()) {
      onBlocked('Finish or cancel the current capture and wait for your photos to save before updating.');
      return;
    }
    if (reloadReady) { location.reload(); return; }
    if (!registration?.waiting) {
      message.textContent = 'No waiting update is available yet. Reload later, or use Refresh app files below.';
      return;
    }
    requested = true;
    button.disabled = true;
    button.textContent = 'Updating...';
    applying = setTimeout(() => {
      requested = false;
      resetButton();
      message.textContent = 'The update did not activate. Try again, or use Refresh app files below.';
    }, 15000);
    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  });
  try {
    registration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
    if (registration.waiting) offerUpdate();
    const observe = worker => {
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) offerUpdate();
        if (worker.state === 'redundant' && !registration.active) {
          document.getElementById('offline').textContent = 'Offline app files could not be installed. Reconnect and refresh the app.';
        }
      });
    };
    observe(registration.installing);
    registration.addEventListener('updatefound', () => observe(registration.installing));
    await navigator.serviceWorker.ready;
    document.getElementById('offline').textContent = 'Offline app files are ready. Keep this app installed and open it before going offline.';
  } catch (cause) {
    document.getElementById('offline').textContent = `Offline setup failed: ${cause.message}. An internet connection is needed to reopen the app.`;
  }
}
