import { CaptureClock, formatTime, parseDuration } from './capture.js';
import { FrameStacker } from './stacker.js';
import { loadPreferences, savePreferences } from './preferences.js';
import { makeThumbnail, savePhoto } from './gallery.js';
import { LocalGallery } from './gallery-ui.js';

const $ = id => document.getElementById(id);
const video = $('video');
const canvas = $('output');
let phase = 'idle';
let stream = null;
let stacker = null;
let clock = null;
let cameraRequest = 0;
let timer = null;
let frameHandle = null;
let frameCallbackKind = null;
let captureRequestedAt = 0;
let countdownUntil = 0;
let lastPreviewAt = 0;
let lastVideoTime = -1;
let wakeLock = null;
let shotGeneration = 0;
let photoFile = null;
let photoURL = null;
let exportGeneration = 0;
let exportTimer = null;
let shot = null;
let protectedGeneration = -1;
const gallery = new LocalGallery(id => {
  if (shot?.id === id && phase === 'result') {
    protectedGeneration = -1;
    storageStatus('Removed from the local gallery. Save a copy to Photos or Files before leaving.', 'failed');
  }
});

function message(text) { $('status').textContent = text; }
function error(text) { $('error').textContent = text; $('error').hidden = !text; }
function notice(text) { $('notice').textContent = text; $('notice').hidden = !text; }
function busy() { return phase === 'countdown' || phase === 'capturing'; }
function unsavedResult() { return phase === 'result' && protectedGeneration !== exportGeneration; }

function storageStatus(text, state) {
  $('photoStorage').textContent = text;
  $('photoStorage').dataset.state = state;
  $('retryStorage').hidden = state !== 'failed';
  $('resultGallery').disabled = state === 'saving';
}

function updateSettings(remember = false) {
  const seconds = Number($('duration').value);
  const valid = Number.isInteger(seconds) && seconds >= 1 && seconds <= 600;
  $('duration').setCustomValidity(valid ? '' : 'Choose a whole number of seconds from 1 to 600.');
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const label = mode === 'trails' ? 'Light trails' : 'Smooth motion';
  const duration = valid ? `${seconds}s` : 'Choose 1-600 seconds';
  $('settingsSummary').textContent = `${duration} / ${label}`;
  if (!busy()) $('dockSummary').textContent = `${duration} / ${label} / ${$('delay').value}s delay`;
  document.querySelectorAll('[data-seconds]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.seconds === $('duration').value));
  });
  if (remember && valid) {
    try {
      savePreferences({ duration: seconds, mode, delay: $('delay').value, quality: $('quality').value });
      $('preferencesStatus').textContent = 'Settings remembered on this device.';
    } catch (cause) {
      $('preferencesStatus').textContent = `Settings could not be remembered: ${cause.message}. They still apply to this session.`;
    }
  }
}

function setPhase(next) {
  phase = next;
  document.body.dataset.phase = phase;
  const editable = phase === 'idle' || phase === 'ready';
  document.querySelectorAll('#settings input, #settings select, #settings button').forEach(control => { control.disabled = !editable; });
  $('settingsPanel').hidden = !editable;
  $('shootingDock').hidden = phase === 'processing' || phase === 'result';
  $('settingsToggle').disabled = !editable;
  $('galleryOpen').disabled = !editable;
  $('enable').hidden = !['idle', 'starting'].includes(phase);
  $('enable').disabled = phase === 'starting';
  $('enable').textContent = phase === 'starting' ? 'Opening camera...' : 'Enable camera';
  $('restart').hidden = phase !== 'ready';
  $('shutter').hidden = phase !== 'ready';
  $('shutter').disabled = phase !== 'ready';
  $('finish').hidden = phase !== 'capturing';
  $('finish').disabled = !clock?.frames;
  $('cancel').hidden = !busy();
  $('result').hidden = phase !== 'result';
  $('countdown').hidden = phase !== 'countdown';
  $('remaining').hidden = phase !== 'capturing';
  if (!busy()) updateSettings();
}

function stopStream() {
  cameraRequest++;
  const old = stream;
  stream = null;
  if (old) old.getTracks().forEach(track => track.stop());
  video.srcObject = null;
}

function cameraError(cause) {
  const known = {
    NotAllowedError: 'Camera access was denied. In Safari, open the page menu > Website Settings > Camera > Allow, then try again.',
    NotFoundError: 'No camera was found on this device.',
    NotReadableError: 'The camera is busy or unavailable. Close other camera apps, then try again.',
    OverconstrainedError: 'This camera cannot use the selected settings. Select the automatic rear camera and 720p, then try again.'
  };
  return known[cause.name] || cause.message || 'The camera could not start.';
}

async function enableCamera() {
  if (!['idle', 'ready', 'result'].includes(phase)) return;
  error('');
  notice('');
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    error('Camera access needs HTTPS. Open the published website in Safari, not a downloaded HTML file or an http:// Wi-Fi address.');
    return;
  }
  stopStream();
  const request = cameraRequest;
  setPhase('starting');
  message('Allow camera access when Safari asks. No microphone permission is needed.');
  try {
    if (!stacker) stacker = new FrameStacker(canvas);
    const longSide = $('quality').value === '720' ? 1280 : 1920;
    const shortSide = $('quality').value === '720' ? 720 : 1080;
    const selection = $('camera').value;
    const acquired = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        ...(selection ? { deviceId: { exact: selection } } : { facingMode: { ideal: 'environment' } }),
        width: { ideal: longSide }, height: { ideal: shortSide },
        frameRate: { ideal: 30, max: 30 }
      }
    });
    if (request !== cameraRequest || document.hidden) {
      acquired.getTracks().forEach(track => track.stop());
      if (request === cameraRequest) {
        setPhase('idle');
        message('Return to the app and enable the camera again.');
      }
      return;
    }
    stream = acquired;
    video.srcObject = stream;
    video.hidden = false;
    canvas.hidden = true;
    $('placeholder').hidden = true;
    await video.play();
    if (request !== cameraRequest) return;
    if (!video.videoWidth || !video.videoHeight) throw new Error('The camera has not supplied a video image. Try enabling it again.');
    const track = stream.getVideoTracks()[0];
    track.addEventListener('ended', () => {
      if (stream?.getVideoTracks()[0] !== track) return;
      if (busy()) interrupt('The camera stopped.');
      else if (phase === 'ready') {
        stopStream();
        setPhase('idle');
        error('The camera stopped. Enable it again.');
      }
    });
    track.addEventListener('mute', () => {
      if (stream?.getVideoTracks()[0] === track && busy()) interrupt('The camera was interrupted.');
    });
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (request !== cameraRequest) return;
      $('camera').replaceChildren(new Option('Rear camera (automatic)', ''));
      devices.filter(device => device.kind === 'videoinput').forEach((device, index) => {
        $('camera').add(new Option(device.label || `Camera ${index + 1}`, device.deviceId));
      });
      $('camera').value = selection;
    } catch (cause) {
      notice(`Camera selection is unavailable: ${cause.message}. The current camera can still take a shot.`);
    }
    if (request !== cameraRequest) return;
    $('resolution').textContent = `${video.videoWidth} x ${video.videoHeight}`;
    $('badge').textContent = 'LIVE CAMERA';
    $('clock').textContent = '00:00';
    $('frames').textContent = '';
    $('progress').value = 0;
    setPhase('ready');
    message('Frame your shot and hold the phone still. Keep the screen on throughout the exposure.');
  } catch (cause) {
    if (request !== cameraRequest) return;
    stopStream();
    setPhase('idle');
    video.hidden = true;
    $('placeholder').hidden = false;
    error(cameraError(cause));
  }
}

async function requestWakeLock(generation) {
  if (!navigator.wakeLock) {
    notice('Automatic screen-awake control is unavailable. Keep the screen on manually. A screen lock interrupts the shot.');
    return;
  }
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (generation !== shotGeneration || !busy()) {
      await lock.release();
      return;
    }
    wakeLock = lock;
    lock.addEventListener('release', () => {
      if (wakeLock === lock) wakeLock = null;
      if (generation === shotGeneration && busy()) notice('The screen-awake lock was released. Keep the screen on manually.');
    });
  } catch (cause) {
    if (generation === shotGeneration && busy()) notice(`Could not keep the screen awake automatically (${cause.message}). Keep it on manually.`);
  }
}

function clearScheduling() {
  clearInterval(timer);
  timer = null;
  if (frameHandle !== null) {
    if (frameCallbackKind === 'video') video.cancelVideoFrameCallback(frameHandle);
    else cancelAnimationFrame(frameHandle);
    frameHandle = null;
  }
  shotGeneration++;
  if (wakeLock) {
    const lock = wakeLock;
    wakeLock = null;
    lock.release().catch(cause => notice(`Could not release the screen-awake lock: ${cause.message}`));
  }
}

function scheduleFrame() {
  if (phase !== 'capturing') return;
  if ('requestVideoFrameCallback' in video) {
    frameCallbackKind = 'video';
    frameHandle = video.requestVideoFrameCallback(onFrame);
  } else {
    frameCallbackKind = 'animation';
    frameHandle = requestAnimationFrame(onFrame);
  }
}

function onFrame(now) {
  frameHandle = null;
  if (phase !== 'capturing') return;
  if (clock.stalled(now)) {
    finish('incomplete', 'Camera frames stopped arriving.');
    return;
  }
  if (clock.complete(now)) {
    finish('complete');
    return;
  }
  if (video.readyState < 2 || (frameCallbackKind === 'animation' && video.currentTime === lastVideoTime)) {
    scheduleFrame();
    return;
  }
  if (video.videoWidth !== shot.sourceWidth || video.videoHeight !== shot.sourceHeight) {
    finish('incomplete', 'The camera orientation or resolution changed. Keep the phone in the same orientation during a shot.');
    return;
  }
  try {
    stacker.add(video);
    clock.addFrame(now);
    lastVideoTime = video.currentTime;
    if (clock.frames === 1) {
      // Keep video laid out behind the canvas so Safari continues presenting camera frames.
      canvas.hidden = false;
      $('finish').disabled = false;
    }
    if (now - lastPreviewAt >= 100 || clock.frames === 1) {
      stacker.render();
      lastPreviewAt = now;
    }
  } catch (cause) {
    finish('incomplete', cause.message);
    return;
  }
  scheduleFrame();
}

function beginCapture() {
  try {
    shot.sourceWidth = video.videoWidth;
    shot.sourceHeight = video.videoHeight;
    stacker.reset(shot.sourceWidth, shot.sourceHeight, shot.mode);
    lastPreviewAt = 0;
    lastVideoTime = -1;
    captureRequestedAt = performance.now();
    setPhase('capturing');
    $('badge').textContent = shot.mode === 'trails' ? 'CAPTURING LIGHT TRAILS' : 'SMOOTHING MOTION';
    message('Exposure in progress. Do not move, rotate, lock, or leave this screen.');
    scheduleFrame();
  } catch (cause) {
    cancelShot(cause.message);
  }
}

function tick() {
  const now = performance.now();
  if (phase === 'countdown') {
    $('countdown').textContent = Math.max(1, Math.ceil((countdownUntil - now) / 1000));
    $('dockSummary').textContent = `Starts in ${Math.max(1, Math.ceil((countdownUntil - now) / 1000))}s / Keep the phone still`;
    if (now >= countdownUntil) beginCapture();
  } else if (phase === 'capturing') {
    $('clock').textContent = formatTime(clock.elapsed(now) / 1000);
    $('progress').value = Math.min(1, clock.elapsed(now) / clock.duration);
    $('frames').textContent = `${clock.frames.toLocaleString()} frames`;
    const remaining = formatTime(Math.ceil(Math.max(0, clock.duration - clock.elapsed(now)) / 1000));
    $('remaining').textContent = `${remaining} left`;
    $('dockSummary').textContent = `${remaining} remaining / ${shot.mode === 'trails' ? 'Light trails' : 'Smooth motion'}`;
    if (clock.stalled(now) || (!clock.frames && now - captureRequestedAt > 5000)) {
      finish('incomplete', 'No new camera frames arrived. Try enabling the camera again.');
    } else if (clock.complete(now)) {
      finish('complete');
    }
  }
}

function startExposure() {
  if (phase !== 'ready') return;
  error('');
  notice('');
  try {
    clock = new CaptureClock(parseDuration($('duration').value));
  } catch (cause) {
    $('settingsPanel').open = true;
    error(cause.message);
    $('duration').focus();
    return;
  }
  shot = {
    id: crypto.randomUUID(),
    requested: clock.duration / 1000,
    mode: document.querySelector('input[name="mode"]:checked').value,
    date: new Date()
  };
  $('progress').value = 0;
  $('clock').textContent = '00:00';
  $('frames').textContent = '';
  updateSettings(true);
  $('settingsPanel').open = false;
  document.querySelector('.viewfinder').scrollIntoView({ block: 'start' });
  countdownUntil = performance.now() + Number($('delay').value) * 1000;
  setPhase('countdown');
  const generation = ++shotGeneration;
  void requestWakeLock(generation);
  message('Settle the phone. The exposure starts after the countdown.');
  timer = setInterval(tick, 100);
  tick();
}

function cancelShot(reason = '') {
  if (!busy()) return;
  clearScheduling();
  stacker?.releaseImages();
  canvas.hidden = true;
  video.hidden = !stream;
  $('placeholder').hidden = Boolean(stream);
  $('badge').textContent = stream ? 'LIVE CAMERA' : 'CAMERA OFF';
  $('progress').value = 0;
  $('clock').textContent = '00:00';
  $('frames').textContent = '';
  setPhase(stream ? 'ready' : 'idle');
  message('Exposure cancelled. No photo was saved.');
  if (reason) error(reason);
}

function interrupt(reason) {
  if (phase === 'countdown') {
    cancelShot(`${reason} The exposure did not start.`);
    stopStream();
    setPhase('idle');
  } else if (phase === 'capturing') {
    finish('incomplete', reason);
  }
}

function clearPhoto() {
  exportGeneration++;
  clearTimeout(exportTimer);
  photoFile = null;
  if (photoURL) URL.revokeObjectURL(photoURL);
  photoURL = null;
  $('share').disabled = true;
  $('download').hidden = true;
  $('download').removeAttribute('href');
  $('openPhoto').hidden = true;
  $('openPhoto').removeAttribute('href');
}

async function protectPhoto(blob, name, generation) {
  const photo = {
    id: shot.id, createdAt: shot.date.getTime(), name, blob,
    width: canvas.width, height: canvas.height,
    mode: shot.mode, actual: shot.actual, requested: shot.requested,
    outcome: shot.outcome, exposure: Number($('ev').value)
  };
  storageStatus('Saving to your local gallery. Keep this page open...', 'saving');
  try {
    const thumbnail = await makeThumbnail(blob);
    if (generation !== exportGeneration) return;
    await savePhoto(photo, thumbnail);
    if (generation === exportGeneration) {
      protectedGeneration = generation;
      storageStatus('Saved to your local gallery. Save important shots to Photos or Files too.', 'saved');
    }
    await gallery.refresh();
  } catch (cause) {
    if (generation === exportGeneration) {
      storageStatus(`Not saved to the gallery: ${cause.message}. Use Save / Share or Download JPEG before leaving. Free local storage and retry if needed.`, 'failed');
    }
  }
}

function buildPhoto() {
  error('');
  clearPhoto();
  const generation = exportGeneration;
  storageStatus('Preparing photo for the local gallery...', 'saving');
  try {
    if (stacker.gl.isContextLost()) throw new Error('Graphics memory was lost. This shot could not be exported.');
    stacker.render(Number($('ev').value));
    canvas.toBlob(blob => {
      if (generation !== exportGeneration || phase !== 'result') return;
      if (!blob) {
        error('The photo could not be encoded. Try adjusting brightness to retry, or take a new shot at 720p.');
        storageStatus('The photo could not be prepared for the gallery. Keep this page open and retry.', 'failed');
        return;
      }
      const stamp = shot.date.toISOString().replace(/[:.]/g, '-');
      const name = `still-${shot.mode}-${shot.actual.toFixed(1)}s-${shot.outcome}-${stamp}.jpg`;
      photoFile = new File([blob], name, { type: 'image/jpeg' });
      photoURL = URL.createObjectURL(blob);
      $('download').href = photoURL;
      $('download').download = name;
      $('download').hidden = false;
      $('openPhoto').href = photoURL;
      $('openPhoto').hidden = false;
      $('share').disabled = false;
      void protectPhoto(blob, name, generation);
    }, 'image/jpeg', 0.96);
  } catch (cause) {
    error(`Unable to prepare the photo: ${cause.message}`);
    storageStatus('The photo is not saved to the gallery. Keep this page open and retry.', 'failed');
  }
}

function finish(outcome, reason = '') {
  if (phase !== 'capturing') return;
  setPhase('processing');
  clearScheduling();
  stopStream();
  if (!clock.frames) {
    stacker.releaseImages();
    setPhase('idle');
    canvas.hidden = true;
    video.hidden = true;
    $('placeholder').hidden = false;
    $('badge').textContent = 'NO PHOTO';
    error(reason || 'No camera frames were captured. Enable the camera and try again.');
    return;
  }
  shot.actual = clock.capturedSeconds;
  shot.outcome = outcome;
  $('ev').value = '0';
  $('evLabel').textContent = '0 EV';
  $('badge').textContent = outcome === 'complete' ? 'EXPOSURE COMPLETE' : outcome === 'stopped' ? 'FINISHED EARLY' : 'INTERRUPTED / PARTIAL';
  $('clock').textContent = formatTime(outcome === 'complete' ? shot.requested : shot.actual);
  $('frames').textContent = `${clock.frames.toLocaleString()} frames`;
  $('progress').value = outcome === 'complete' ? 1 : Math.min(1, shot.actual / shot.requested);
  $('summary').textContent = `${shot.actual.toFixed(1)}s captured / ${shot.requested}s set`;
  video.hidden = true;
  canvas.hidden = false;
  setPhase('result');
  message(outcome === 'complete' ? 'Your exposure is ready. Save a copy to Photos, or find it in your local gallery.' : 'A partial exposure is ready. Its gallery entry will be marked as partial.');
  if (reason) notice(`${reason} This is a partial exposure, not the full requested duration.`);
  buildPhoto();
}

$('enable').addEventListener('click', () => {
  $('settingsPanel').open = false;
  document.querySelector('.viewfinder').scrollIntoView({ block: 'start' });
  void enableCamera();
});
$('restart').addEventListener('click', enableCamera);
$('shutter').addEventListener('click', startExposure);
$('cancel').addEventListener('click', () => cancelShot());
$('finish').addEventListener('click', () => finish('stopped'));
$('again').addEventListener('click', () => {
  if (unsavedResult() && !window.confirm('This photo or its latest brightness change is not saved to the local gallery yet. Save it to Photos or Files first. Discard the current result and take another shot?')) return;
  clearPhoto();
  stacker.releaseImages();
  void enableCamera();
});
$('presets').addEventListener('click', event => {
  const button = event.target.closest('button[data-seconds]');
  if (!button || button.disabled) return;
  $('duration').value = button.dataset.seconds;
  $('duration').dispatchEvent(new Event('input'));
});
$('duration').addEventListener('input', () => updateSettings(true));
$('settings').addEventListener('change', () => updateSettings(true));
$('settingsToggle').addEventListener('click', () => {
  $('settingsPanel').open = !$('settingsPanel').open;
  if ($('settingsPanel').open) $('settingsPanel').scrollIntoView({ block: 'start' });
});
$('settingsPanel').addEventListener('toggle', () => {
  $('settingsToggle').setAttribute('aria-expanded', String($('settingsPanel').open));
});
$('galleryOpen').addEventListener('click', () => { void gallery.open(); });
$('resultGallery').addEventListener('click', () => { void gallery.open(); });
$('retryStorage').addEventListener('click', () => {
  if (photoFile) void protectPhoto(photoFile, photoFile.name, exportGeneration);
  else buildPhoto();
});
for (const id of ['quality', 'camera']) {
  $(id).addEventListener('change', () => {
    if (phase === 'ready') void enableCamera();
  });
}
$('ev').addEventListener('input', () => {
  const value = Number($('ev').value);
  $('evLabel').textContent = `${value > 0 ? '+' : ''}${value.toFixed(1)} EV`;
  clearPhoto();
  storageStatus('Brightness changed. Preparing an updated gallery copy...', 'saving');
  stacker.render(value);
  exportTimer = setTimeout(buildPhoto, 180);
});
$('share').addEventListener('click', async () => {
  if (!photoFile) {
    error('The photo is still being prepared. Wait a moment and try again.');
    return;
  }
  try {
    if (navigator.canShare?.({ files: [photoFile] })) {
      // Call share directly in the tap handler to preserve iOS user activation.
      await navigator.share({ files: [photoFile] });
    } else {
      $('download').click();
      message('Open the downloaded JPEG to save it. On iPhone you can also open the full-size photo and press and hold it.');
    }
  } catch (cause) {
    if (cause.name !== 'AbortError') error(`Sharing failed: ${cause.message}. Use Download JPEG or Open full-size photo instead.`);
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && busy()) interrupt('The app left the foreground or the screen locked.');
  else if (document.hidden && ['ready', 'starting'].includes(phase)) {
    stopStream();
    setPhase('idle');
    message('The camera was paused while the app was hidden. Enable it again.');
  }
});
window.addEventListener('pagehide', () => {
  if (busy()) interrupt('The page was closed or navigated away.');
  stopStream();
});
window.addEventListener('beforeunload', event => {
  if (busy() || unsavedResult()) {
    event.preventDefault();
    event.returnValue = '';
  }
});
canvas.addEventListener('webglcontextlost', event => {
  event.preventDefault();
  if (busy()) {
    clearScheduling();
    stopStream();
    setPhase('idle');
  }
  if (!photoFile) error('iOS released the graphics memory. This exposure could not be kept. Reload the app and try 720p.');
  else notice('Graphics memory was released. Save the existing photo now, then reload before taking another.');
  $('shutter').disabled = true;
  $('enable').disabled = true;
  $('ev').disabled = true;
  $('again').disabled = true;
});
try {
  const saved = loadPreferences();
  if (saved) {
    $('duration').value = String(saved.duration);
    document.querySelector(`input[name="mode"][value="${saved.mode}"]`).checked = true;
    $('delay').value = saved.delay;
    $('quality').value = saved.quality;
  }
} catch (cause) {
  $('preferencesStatus').textContent = `Saved settings could not be loaded: ${cause.message}. Default settings are being used.`;
}
setPhase('idle');
void gallery.refresh();
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js').then(async () => {
    await navigator.serviceWorker.ready;
    $('offline').textContent = 'Offline app files are ready. Keep this app installed and open it before going offline.';
  }).catch(cause => {
    $('offline').textContent = `Offline setup failed: ${cause.message}. An internet connection is needed to reopen the app.`;
  });
} else {
  $('offline').textContent = 'Offline installation is unavailable in this browser.';
}
