export function abortError() {
  return new DOMException('Moon processing was cancelled.', 'AbortError');
}

export function checkAbort(signal) {
  if (signal.aborted) throw abortError();
}

export function cameraOperation(promise, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const clean = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
    };
    const aborted = () => { clean(); reject(abortError()); };
    const timer = setTimeout(() => {
      clean();
      reject(new Error('The camera operation did not respond. Re-enable the camera or import native-camera photos instead.'));
    }, 15000);
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(value => { clean(); resolve(value); }, cause => { clean(); reject(cause); });
  });
}

export function delay(milliseconds, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted);
      resolve();
    }, milliseconds);
    const aborted = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener('abort', aborted, { once: true });
  });
}

export function mediaEvent(element, name, signal, start, timeout = 15000) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const clean = () => {
      clearTimeout(timer);
      element.removeEventListener(name, done);
      element.removeEventListener('error', failed);
      signal.removeEventListener('abort', aborted);
    };
    const done = () => { clean(); resolve(); };
    const failed = () => { clean(); reject(new Error('This media could not be decoded. Try JPEG photos or an H.264/HEVC video recorded by Camera.')); };
    const aborted = () => { clean(); reject(abortError()); };
    const timer = setTimeout(() => {
      clean();
      reject(new Error('Media decoding timed out. Try a shorter video or export the photos as JPEG.'));
    }, timeout);
    element.addEventListener(name, done, { once: true });
    element.addEventListener('error', failed, { once: true });
    signal.addEventListener('abort', aborted, { once: true });
    try { start(); } catch (cause) { clean(); reject(cause); }
  });
}

export async function loadPhoto(blob, signal) {
  const url = URL.createObjectURL(blob);
  const image = new Image();
  try {
    await mediaEvent(image, 'load', signal, () => { image.src = url; });
    if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 100000000) {
      throw new Error('This image is too large to process safely. Import a smaller JPEG.');
    }
    return { image, release: () => { image.removeAttribute('src'); URL.revokeObjectURL(url); } };
  } catch (cause) {
    image.removeAttribute('src');
    URL.revokeObjectURL(url);
    throw cause;
  }
}

export async function seekVideo(video, time, signal) {
  checkAbort(signal);
  if (Math.abs(video.currentTime - time) < 0.001 && video.readyState >= 2) return;
  await mediaEvent(video, 'seeked', signal, () => { video.currentTime = time; }, 10000);
  if (video.readyState < 2) {
    await mediaEvent(video, 'loadeddata', signal, () => {}, 10000);
  }
}

export function nextVideoFrame(video, signal) {
  if (!video.requestVideoFrameCallback) return delay(40, signal);
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    let handle;
    const clean = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
    };
    const aborted = () => {
      video.cancelVideoFrameCallback(handle);
      clean();
      reject(abortError());
    };
    const timer = setTimeout(() => {
      video.cancelVideoFrameCallback(handle);
      clean();
      reject(new Error('The camera stopped supplying frames. Keep the app visible and try again.'));
    }, 2500);
    signal.addEventListener('abort', aborted, { once: true });
    handle = video.requestVideoFrameCallback(() => { clean(); resolve(); });
  });
}

export class MoonWorker {
  constructor() {
    this.worker = new Worker(new URL('./moon-worker.js', import.meta.url), { type: 'module' });
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
    this.worker.onmessage = ({ data }) => {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      clearTimeout(pending.timer);
      if (data.error) pending.reject(new Error(data.error));
      else pending.resolve(data.result);
    };
    this.worker.onerror = event => {
      event.preventDefault();
      this.close(new Error(event.message || 'Moon processing failed. Reload the app and try again.'));
    };
  }

  request(type, frame) {
    if (this.closed) return Promise.reject(new Error('The Moon processor has stopped. Start a new capture.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(new Error('Moon processing took too long. Try fewer or smaller images.')), 45000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.worker.postMessage({ id, type, frame }, frame ? [frame.data.buffer] : []);
      } catch (cause) {
        this.close(cause);
      }
    });
  }

  close(reason = abortError()) {
    this.closed = true;
    this.worker.terminate();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
  }
}
