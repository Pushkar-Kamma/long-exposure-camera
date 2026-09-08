import { MoonStack } from './moon-core.js';

let stack = null;
self.onmessage = event => {
  const { id, type, frame } = event.data;
  try {
    if (type === 'reset') {
      stack = new MoonStack({ maxFrames: 24 });
      self.postMessage({ id, result: true });
    } else if (type === 'frame') {
      if (!stack) throw new Error('Start a new Moon capture first.');
      self.postMessage({ id, result: stack.add(frame) });
    } else if (type === 'finish') {
      if (!stack) throw new Error('No Moon frames have been collected.');
      const result = stack.finish();
      // Do not transfer the same buffer twice if a single-frame result shares its reference.
      const buffers = [...new Set([result.image.data.buffer, result.reference.data.buffer])];
      self.postMessage({ id, result }, buffers);
      stack = null;
    } else {
      throw new Error('Unknown Moon processing request.');
    }
  } catch (cause) {
    self.postMessage({ id, error: cause.message });
  }
};
