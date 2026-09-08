import { analyzeMoon } from './moon-core.js';
import { createMoonSimulation } from './moon-simulation.js';
import { MoonWorker, cameraOperation, checkAbort, delay, loadPhoto, mediaEvent, nextVideoFrame, seekVideo } from './moon-media.js';
import { makeThumbnail, savePhoto } from './gallery.js';

const $ = id => document.getElementById(id);

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The Moon image could not be encoded. Try a smaller import.')), 'image/jpeg', 0.96);
  });
}

function drawFrame(canvas, frame, simulated = false) {
  canvas.width = frame.width;
  canvas.height = frame.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The image renderer is unavailable.');
  context.putImageData(new ImageData(frame.data, frame.width, frame.height), 0, 0);
  if (simulated) {
    const fontSize = Math.max(9, Math.round(frame.width / 22));
    context.fillStyle = '#000';
    context.fillRect(0, frame.height - fontSize * 2, frame.width, fontSize * 2);
    context.fillStyle = '#fff';
    context.font = `bold ${fontSize}px sans-serif`;
    context.fillText('SIMULATED / NOT A MOON PHOTO', 4, frame.height - Math.round(fontSize / 2));
  }
}

export class MoonController {
  constructor({ onSaved, openGallery }) {
    this.onSaved = onSaved;
    this.openGallery = openGallery;
    this.stream = null;
    this.job = null;
    this.processor = null;
    this.cameraGeneration = 0;
    this.opening = false;
    this.openingGeneration = null;
    this.configuring = false;
    this.controlJob = null;
    this.result = null;
    this.protected = false;
    this.file = null;
    this.urls = [];
    this.detector = document.createElement('canvas');
    this.crop = document.createElement('canvas');
    this.detectorContext = this.detector.getContext('2d', { willReadFrequently: true });
    this.cropContext = this.crop.getContext('2d', { willReadFrequently: true });
    $('moonClose').addEventListener('click', () => this.close());
    $('moonDialog').addEventListener('cancel', event => { event.preventDefault(); this.close(); });
    $('moonEnable').addEventListener('click', () => { void this.enableCamera(); });
    $('moonCamera').addEventListener('change', () => { if (this.stream) void this.enableCamera(); });
    $('moonCapture').addEventListener('click', () => { void this.capture(); });
    $('moonStill').addEventListener('click', () => { void this.captureStill(); });
    $('moonDemo').addEventListener('click', () => { void this.demo(); });
    $('moonFiles').addEventListener('change', () => {
      const files = [...$('moonFiles').files];
      $('moonFiles').value = '';
      if (files.length) void this.importFiles(files);
    });
    $('moonCancel').addEventListener('click', () => this.cancel());
    $('moonExposure').addEventListener('change', () => { void this.applyControl('exposureCompensation', 'moonExposure', 'moonExposureValue'); });
    $('moonZoom').addEventListener('change', () => { void this.applyControl('zoom', 'moonZoom', 'moonZoomValue'); });
    $('moonShare').addEventListener('click', () => { void this.share(); });
    $('moonRetry').addEventListener('click', () => { void this.protect(); });
    $('moonGallery').addEventListener('click', () => { void this.openGallery(); });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) return;
      if (this.isWorking) this.cancel('Moon capture was interrupted because the app left the foreground. Keep it visible and try again.');
      else if (this.stream) {
        this.stopCamera();
        this.status('The Moon camera was paused. Enable it again when ready.');
      }
    });
    window.addEventListener('pagehide', () => { this.cancel(); this.stopCamera(); });
  }

  get isWorking() { return Boolean(this.job) || this.opening || this.configuring; }
  get hasUnsavedResult() { return Boolean(this.result) && !this.protected; }
  status(text) { $('moonStatus').textContent = text; }
  error(text) { $('moonError').textContent = text; $('moonError').hidden = !text; }

  open() {
    $('moonDialog').showModal();
    this.updateControls();
  }

  close() {
    if (this.hasUnsavedResult && !window.confirm('This Moon result is not saved to the gallery yet. Save or download it first. Close anyway?')) return;
    if (this.isWorking && !this.result && !window.confirm('Cancel this Moon capture and close? No result will be saved.')) return;
    this.cancel();
    this.stopCamera();
    $('moonDialog').close();
  }

  updateControls() {
    document.querySelectorAll('#moonSetup input, #moonSetup select, #moonSetup button').forEach(control => { control.disabled = this.isWorking; });
    $('moonCapture').disabled = this.isWorking || !this.stream;
    $('moonStill').hidden = !this.stream || typeof globalThis.ImageCapture?.prototype?.takePhoto !== 'function';
    $('moonCancel').hidden = !this.isWorking || Boolean(this.result);
    $('moonResult').hidden = !this.result;
    $('moonSetup').hidden = Boolean(this.job) && !this.result;
    $('moonEnable').textContent = this.opening ? 'Opening camera...' : this.stream ? 'Restart Moon camera' : 'Enable Moon camera';
  }

  releaseResult() {
    this.result = null;
    this.protected = false;
    this.file = null;
    this.urls.forEach(url => URL.revokeObjectURL(url));
    this.urls = [];
    $('moonShare').disabled = true;
    $('moonDownload').hidden = true;
    $('moonDownload').removeAttribute('href');
    $('moonReferenceDownload').removeAttribute('href');
    $('moonResult').hidden = true;
  }

  confirmNewResult() {
    if (this.hasUnsavedResult && !window.confirm('This Moon result is not saved to the gallery. Save or download it first. Discard it and start another?')) return false;
    this.releaseResult();
    return true;
  }

  stopCamera() {
    this.cameraGeneration++;
    const stream = this.stream;
    this.stream = null;
    stream?.getTracks().forEach(track => track.stop());
    $('moonVideo').srcObject = null;
    $('moonVideo').hidden = true;
    if ($('moonOutput').hidden) $('moonPlaceholder').hidden = false;
    $('moonExposureControl').hidden = true;
    $('moonZoomControl').hidden = true;
    this.updateControls();
  }

  cancel(reason = '') {
    this.cameraGeneration++;
    this.opening = false;
    this.openingGeneration = null;
    this.configuring = false;
    this.controlJob?.abort();
    this.controlJob = null;
    this.job?.abort();
    this.processor?.close();
    if (this.job && !this.result) {
      this.status('Moon capture cancelled. No new result was saved.');
      $('moonBadge').textContent = 'CANCELLED / NO NEW RESULT';
    }
    this.stopCamera();
    if (reason) this.error(reason);
    this.updateControls();
  }

  async enableCamera() {
    if (this.isWorking) return;
    if (!this.confirmNewResult()) return;
    this.error('');
    if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this.error('Camera access needs HTTPS and a supported browser. The demo and file imports can still be used.');
      return;
    }
    this.stopCamera();
    const generation = this.cameraGeneration;
    this.opening = true;
    this.openingGeneration = generation;
    this.updateControls();
    try {
      const selection = $('moonCamera').value;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          ...(selection ? { deviceId: { exact: selection } } : { facingMode: { ideal: 'environment' } }),
          width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 }
        }
      });
      if (generation !== this.cameraGeneration || document.hidden || !$('moonDialog').open) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      this.stream = stream;
      $('moonVideo').removeAttribute('src');
      $('moonVideo').srcObject = stream;
      $('moonVideo').hidden = false;
      $('moonOutput').hidden = true;
      $('moonPlaceholder').hidden = true;
      await $('moonVideo').play();
      if (generation !== this.cameraGeneration) return;
      const track = stream.getVideoTracks()[0];
      track.addEventListener('ended', () => {
        if (this.stream?.getVideoTracks()[0] === track) this.cancel('The camera stopped. Enable it again.');
      });
      track.addEventListener('mute', () => {
        if (this.stream?.getVideoTracks()[0] === track && this.job) this.cancel('Camera frames were interrupted. Try again with this app visible.');
      });
      const caps = track.getCapabilities?.() || {};
      const settings = track.getSettings();
      this.configureControl(caps.exposureCompensation, settings.exposureCompensation, 'moonExposure', 'moonExposureControl', 'moonExposureValue');
      this.configureControl(caps.zoom, settings.zoom, 'moonZoom', 'moonZoomControl', 'moonZoomValue');
      $('moonCapabilities').textContent = [
        `Camera: ${track.label || 'unnamed'}. Stream: ${settings.width || '?'} x ${settings.height || '?'}.`,
        `Exposure compensation: ${caps.exposureCompensation ? 'advertised, changes require confirmation' : 'not exposed'}.`,
        `Camera zoom: ${caps.zoom ? 'advertised, not a guarantee of optical zoom' : 'not exposed'}.`,
        `Focus: browser-controlled${Array.isArray(caps.focusMode) ? ` (advertised modes: ${caps.focusMode.join(', ')})` : ''}. No focus lock is assumed.`,
        `Sensor shutter/ISO: ${caps.exposureTime || caps.iso ? 'some capabilities advertised, not overridden by this mode' : 'not exposed'}.`,
        `Still-photo API: ${typeof globalThis.ImageCapture?.prototype?.takePhoto === 'function' ? 'available to try, actual output resolution is measured after capture' : 'unavailable'}.`,
        'Rear-camera selection does not guarantee the physical telephoto lens. Try a specifically named telephoto camera if listed.'
      ].join(' ');
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (generation !== this.cameraGeneration) return;
        $('moonCamera').replaceChildren(new Option('Rear camera (automatic)', ''));
        devices.filter(device => device.kind === 'videoinput').forEach((device, index) => {
          $('moonCamera').add(new Option(device.label || `Camera ${index + 1}`, device.deviceId));
        });
        $('moonCamera').value = selection;
      } catch (cause) {
        $('moonCapabilities').textContent += ` Camera list unavailable: ${cause.message}.`;
      }
      $('moonBadge').textContent = 'LIVE / SENSOR EXPOSURE IS NOT THE BURST WINDOW';
      this.status('Point at an isolated Moon. Keep the full outline in frame. If it is a white blob and exposure control is unavailable, use a native-camera import.');
    } catch (cause) {
      if (generation === this.cameraGeneration) {
        this.stopCamera();
        this.error(`Moon camera could not start: ${cause.message}. Allow camera access in Safari, or use an import or the demo.`);
      }
    } finally {
      if (this.openingGeneration === generation) {
        this.opening = false;
        this.openingGeneration = null;
      }
      this.updateControls();
    }
  }

  configureControl(capability, actual, inputId, wrapperId, outputId) {
    const supported = capability && Number.isFinite(capability.min) && Number.isFinite(capability.max) && capability.max > capability.min;
    $(wrapperId).hidden = !supported;
    if (!supported) return;
    const input = $(inputId);
    input.min = String(capability.min);
    input.max = String(capability.max);
    input.step = String(capability.step > 0 ? capability.step : 0.1);
    input.value = String(Number.isFinite(actual) ? actual : Math.max(capability.min, Math.min(capability.max, 0)));
    input.dataset.confirmed = Number.isFinite(actual) ? String(actual) : '';
    $(outputId).textContent = Number.isFinite(actual) ? actual.toFixed(1) : 'current value not reported';
  }

  async applyControl(key, inputId, outputId) {
    const track = this.stream?.getVideoTracks()[0];
    if (!track || this.isWorking) return;
    const input = $(inputId);
    const requested = Number(input.value);
    const controlJob = new AbortController();
    this.controlJob = controlJob;
    this.configuring = true;
    this.updateControls();
    try {
      await cameraOperation(track.applyConstraints({ advanced: [{ [key]: requested }] }), controlJob.signal);
      if (this.stream?.getVideoTracks()[0] !== track) return;
      const actual = track.getSettings()[key];
      if (!Number.isFinite(actual) || Math.abs(actual - requested) > Math.max(Number(input.step) / 2, 0.01)) {
        throw new Error('The browser did not confirm that this setting changed.');
      }
      input.dataset.confirmed = String(actual);
      $(outputId).textContent = actual.toFixed(1);
      this.error('');
      this.status(`${key === 'zoom' ? 'Camera zoom factor' : 'Capture exposure compensation'} confirmed at ${actual.toFixed(1)}. This does not guarantee a particular optical lens.`);
    } catch (cause) {
      if (cause.name !== 'AbortError') {
        if (input.dataset.confirmed) input.value = input.dataset.confirmed;
        this.error(`Camera control was not confirmed: ${cause.message} Do not rely on it to correct an overexposed Moon.`);
      }
    } finally {
      if (this.controlJob === controlJob) {
        this.controlJob = null;
        this.configuring = false;
      }
      this.updateControls();
    }
  }

  async run(source, producer) {
    if (this.isWorking || !this.confirmNewResult()) return;
    this.error('');
    const job = new AbortController();
    this.job = job;
    this.source = source;
    this.attempted = 0;
    this.accepted = 0;
    this.lastReason = '';
    this.cropPixels = 0;
    this.actual = 0;
    this.requested = 0;
    this.inputDimensions = '';
    this.inputWidth = 0;
    this.inputHeight = 0;
    $('moonProgress').value = 0;
    $('moonBadge').textContent = source === 'simulation' ? 'SIMULATED TEST SCENE / NOT A MOON PHOTO' : 'COLLECTING SHORT-EXPOSURE FRAMES';
    $('moonPlaceholder').hidden = true;
    $('moonOutput').hidden = true;
    $('moonDialog').scrollTop = 0;
    this.updateControls();
    try {
      this.processor = new MoonWorker();
      await this.processor.request('reset');
      await producer(job.signal);
      checkAbort(job.signal);
      if (!this.accepted) throw new Error(this.lastReason || 'No usable Moon was found. Import a correctly exposed Moon against dark sky, fully inside the frame.');
      this.status('Selecting sharper frames and aligning real surface detail...');
      $('moonBadge').textContent = source === 'simulation' ? 'PROCESSING SIMULATED DATA' : 'ALIGNING / NO GENERATED DETAIL';
      const result = await this.processor.request('finish');
      checkAbort(job.signal);
      await this.publish(result, job.signal);
    } catch (cause) {
      if (cause.name !== 'AbortError') {
        this.error(cause.message);
        $('moonBadge').textContent = 'NO USABLE RESULT';
        this.status('No result was saved. More zoom or darkening a finished white blob cannot recover clipped lunar detail.');
      }
    } finally {
      this.processor?.close();
      this.processor = null;
      if (this.job === job) this.job = null;
      this.stopCamera();
      this.updateControls();
      if (this.result && $('moonDialog').open) $('moonResult').scrollIntoView({ block: 'nearest' });
    }
  }

  async addSource(source, width, height, signal) {
    checkAbort(signal);
    this.attempted++;
    if (!width || !height) throw new Error('No image pixels arrived from the camera or file.');
    if (this.inputWidth && (this.inputWidth !== width || this.inputHeight !== height)) {
      this.lastReason = 'Frames with different image dimensions were skipped. Use the same camera, orientation, zoom, and resolution throughout a sequence.';
      this.status(this.lastReason);
      return;
    }
    const scale = Math.min(1, 512 / Math.max(width, height));
    this.detector.width = Math.max(1, Math.round(width * scale));
    this.detector.height = Math.max(1, Math.round(height * scale));
    this.detectorContext.fillStyle = '#000';
    this.detectorContext.fillRect(0, 0, this.detector.width, this.detector.height);
    this.detectorContext.drawImage(source, 0, 0, this.detector.width, this.detector.height);
    const detection = analyzeMoon(this.detectorContext.getImageData(0, 0, this.detector.width, this.detector.height));
    if (!detection.ok) {
      this.lastReason = detection.reason || 'No usable lunar outline was found.';
      this.status(`Skipped frame ${this.attempted}: ${this.lastReason}`);
      return;
    }
    this.inputWidth = width;
    this.inputHeight = height;
    this.inputDimensions = `${width} x ${height}`;
    const sourceScale = width / this.detector.width;
    if (!this.cropPixels) this.cropPixels = Math.min(width, height, Math.max(24, Math.ceil(detection.diameter * sourceScale * 1.8)));
    const size = Math.min(384, this.cropPixels);
    if (this.crop.width !== size) { this.crop.width = size; this.crop.height = size; }
    const x = Math.max(0, Math.min(width - this.cropPixels, detection.centerX * sourceScale - this.cropPixels / 2));
    const y = Math.max(0, Math.min(height - this.cropPixels, detection.centerY * height / this.detector.height - this.cropPixels / 2));
    this.cropContext.fillStyle = '#000';
    this.cropContext.fillRect(0, 0, size, size);
    this.cropContext.drawImage(source, x, y, this.cropPixels, this.cropPixels, 0, 0, size, size);
    const frame = this.cropContext.getImageData(0, 0, size, size);
    drawFrame($('moonOutput'), frame);
    $('moonOutput').hidden = false;
    const added = await this.processor.request('frame', { width: size, height: size, data: frame.data });
    if (added.accepted) this.accepted++;
    else this.lastReason = added.reason || 'The frame did not match the Moon sequence.';
    this.status(`${this.attempted} sampled / ${this.accepted} usable. ${added.accepted ? 'Keep the phone still.' : this.lastReason}`);
  }

  async capture() {
    if (!this.stream) { this.error('Enable the Moon camera first.'); return; }
    await this.run('camera-burst', async signal => {
      const duration = Number($('moonDuration').value);
      this.requested = duration;
      const video = $('moonVideo');
      const start = performance.now();
      let lastSample = -Infinity;
      let lastVideoTime = -1;
      let firstAt = null;
      let lastAt = null;
      while (performance.now() - start < duration * 1000) {
        await nextVideoFrame(video, signal);
        checkAbort(signal);
        const now = performance.now();
        $('moonProgress').value = Math.min(1, (now - start) / (duration * 1000));
        if (now - lastSample < 100 || video.currentTime === lastVideoTime) continue;
        if (!this.stream || video.readyState < 2) throw new Error('The camera was interrupted. Keep this screen open and try again.');
        lastSample = now;
        lastVideoTime = video.currentTime;
        if (firstAt === null) firstAt = now;
        lastAt = now;
        await this.addSource(video, video.videoWidth, video.videoHeight, signal);
      }
      this.actual = firstAt === null ? 0 : (lastAt - firstAt) / 1000;
    });
  }

  async captureStill() {
    const track = this.stream?.getVideoTracks()[0];
    if (!track) { this.error('Enable the Moon camera first.'); return; }
    await this.run('camera-still', async signal => {
      const capture = new ImageCapture(track);
      const caps = capture.getPhotoCapabilities ? await cameraOperation(capture.getPhotoCapabilities(), signal) : {};
      checkAbort(signal);
      this.status('Requesting an actual still photo from this browser...');
      const blob = await cameraOperation(capture.takePhoto(caps.fillLightMode?.includes('off') ? { fillLightMode: 'off' } : {}), signal);
      checkAbort(signal);
      const photo = await loadPhoto(blob, signal);
      try { await this.addSource(photo.image, photo.image.naturalWidth, photo.image.naturalHeight, signal); }
      finally { photo.release(); }
    });
  }

  async demo() {
    this.stopCamera();
    await this.run('simulation', async signal => {
      const simulation = createMoonSimulation({ count: 48, seed: 2026 });
      let count = 0;
      for (const frame of simulation.frames) {
        checkAbort(signal);
        this.attempted++;
        drawFrame($('moonOutput'), frame);
        $('moonOutput').hidden = false;
        this.inputDimensions = `${frame.width} x ${frame.height}`;
        const added = await this.processor.request('frame', frame);
        if (added.accepted) this.accepted++;
        else this.lastReason = added.reason || 'Synthetic frame rejected.';
        $('moonProgress').value = ++count / 48;
        this.status(`Simulated frame ${count}/48. Testing movement, blur, clipping, and noise. No real Moon photo is being created.`);
        await delay(0, signal);
      }
    });
  }

  async importFiles(files) {
    if (files.length > 20) { this.error('Choose at most 20 photos from the same Moon sequence, or one video.'); return; }
    const videos = files.filter(file => file.type.startsWith('video/'));
    if (videos.length && files.length !== 1) { this.error('Import either photos or one video, not a mixture.'); return; }
    if (!videos.length && files.some(file => !file.type.startsWith('image/'))) { this.error('Import supported photos or a video. RAW/DNG processing is not supported.'); return; }
    if (files.some(file => file.size > (videos.length ? 250 : 40) * 1024 * 1024)) { this.error('Use photos under 40 MB each or a video under 250 MB. Export smaller files before importing.'); return; }
    this.stopCamera();
    await this.run(videos.length ? 'imported-video' : 'imported-photos', async signal => {
      if (!videos.length) {
        $('moonVideo').hidden = true;
        for (let index = 0; index < files.length; index++) {
          const photo = await loadPhoto(files[index], signal);
          try { await this.addSource(photo.image, photo.image.naturalWidth, photo.image.naturalHeight, signal); }
          finally { photo.release(); }
          $('moonProgress').value = (index + 1) / files.length;
        }
        return;
      }
      const url = URL.createObjectURL(files[0]);
      const video = $('moonVideo');
      try {
        video.hidden = false;
        await mediaEvent(video, 'loadedmetadata', signal, () => { video.src = url; video.load(); });
        if (video.duration === Infinity) {
          // Some MediaRecorder WebM files omit duration metadata until the last cluster is read.
          await seekVideo(video, 1e10, signal);
        }
        if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('This video has no readable duration. Export it as a normal video file first.');
        const duration = Math.min(8, video.duration);
        this.requested = duration;
        const count = Math.max(1, Math.ceil(duration * 10));
        let lastTime = 0;
        for (let index = 0; index < count; index++) {
          const time = Math.min(Math.max(0, video.duration - 0.02), Math.max(0.001, index / 10));
          await seekVideo(video, time, signal);
          await this.addSource(video, video.videoWidth, video.videoHeight, signal);
          lastTime = time;
          $('moonProgress').value = (index + 1) / count;
        }
        this.actual = lastTime;
      } finally {
        video.pause();
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(url);
      }
    });
  }

  async publish(processed, signal) {
    const simulated = this.source === 'simulation';
    drawFrame($('moonOutput'), processed.image, simulated);
    drawFrame($('moonReference'), processed.reference, simulated);
    $('moonOutput').hidden = false;
    $('moonVideo').hidden = true;
    const blob = await canvasBlob($('moonOutput'));
    const referenceBlob = await canvasBlob($('moonReference'));
    checkAbort(signal);
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const name = `still-moon-${simulated ? 'SIMULATED-' : ''}${new Date(createdAt).toISOString().replace(/[:.]/g, '-')}.jpg`;
    this.result = {
      id, createdAt, name, blob, referenceBlob, simulated, source: this.source,
      mode: 'moon', actual: this.actual, requested: this.requested, outcome: 'complete',
      width: processed.image.width, height: processed.image.height,
      framesUsed: processed.stats.used, framesSampled: this.attempted, inputDimensions: this.inputDimensions
    };
    this.file = new File([blob], name, { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    const referenceURL = URL.createObjectURL(referenceBlob);
    this.urls.push(url, referenceURL);
    $('moonDownload').href = url;
    $('moonDownload').download = name;
    $('moonDownload').hidden = false;
    $('moonReferenceDownload').href = referenceURL;
    $('moonReferenceDownload').download = name.replace('.jpg', '-best-single.jpg');
    $('moonShare').disabled = false;
    $('moonResult').hidden = false;
    $('moonCancel').hidden = true;
    $('moonProgress').value = 1;
    $('moonBadge').textContent = simulated ? 'SIMULATED DEMO / WATERMARKED' : processed.stats.used > 1 ? 'ALIGNED MOON RESULT' : 'SINGLE FRAME / NOT A STACK';
    $('moonStats').textContent = `${processed.stats.used} frame(s) used from ${this.attempted} sampled, ${this.attempted - processed.stats.used} not used. Input ${this.inputDimensions}, cropped output ${processed.image.width} x ${processed.image.height}. ${processed.warning || ''} ${simulated ? 'Synthetic scene only. This does not demonstrate performance on your physical iPhone.' : 'No generated surface detail or digital upscaling was added.'}`;
    this.status(simulated ? 'The simulated result and best input are ready to compare. Both exports are labelled SIMULATED.' : 'Compare the result with the best single input. More stacked frames do not guarantee more real detail.');
    await this.protect();
  }

  async protect() {
    const result = this.result;
    if (!result) { this.error('There is no Moon result to save.'); return; }
    $('moonStorage').dataset.state = 'saving';
    $('moonStorage').textContent = 'Saving result and best single frame to the local gallery...';
    $('moonRetry').hidden = true;
    $('moonGallery').disabled = true;
    try {
      const thumbnail = await makeThumbnail(result.blob);
      if (this.result !== result) return;
      await savePhoto(result, thumbnail);
      if (this.result === result) {
        this.protected = true;
        $('moonStorage').dataset.state = 'saved';
        $('moonStorage').textContent = 'Saved to the local gallery with the best single frame. Save important photos to Photos or Files too.';
      }
      await this.onSaved();
    } catch (cause) {
      if (this.result === result) {
        $('moonStorage').dataset.state = 'failed';
        $('moonStorage').textContent = `Not saved to the gallery: ${cause.message}. Download or share the result before closing.`;
        $('moonRetry').hidden = false;
      }
    } finally {
      $('moonGallery').disabled = false;
    }
  }

  onGalleryDelete(id) {
    if (this.result?.id === id) {
      this.protected = false;
      $('moonStorage').dataset.state = 'failed';
      $('moonStorage').textContent = 'Removed from the gallery. Download the current result before leaving if you want to keep it.';
      $('moonRetry').hidden = false;
    }
  }

  async share() {
    if (!this.result) { this.error('Create a Moon result before sharing.'); return; }
    try {
      if (navigator.canShare?.({ files: [this.file] })) await navigator.share({ files: [this.file] });
      else $('moonDownload').click();
    } catch (cause) {
      if (cause.name !== 'AbortError') this.error(`Sharing failed: ${cause.message}. Use Download result instead.`);
    }
  }
}
