export function parseDuration(value) {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) {
    throw new Error('Choose a whole number of seconds from 1 to 600.');
  }
  return seconds;
}

export function formatTime(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60).toString().padStart(2, '0')}:${(whole % 60).toString().padStart(2, '0')}`;
}

export class CaptureClock {
  constructor(seconds) {
    this.duration = parseDuration(seconds) * 1000;
    this.startedAt = null;
    this.lastFrameAt = null;
    this.frames = 0;
  }

  addFrame(now) {
    if (this.startedAt === null) this.startedAt = now;
    this.lastFrameAt = now;
    this.frames++;
  }

  elapsed(now) {
    return this.startedAt === null ? 0 : Math.max(0, now - this.startedAt);
  }

  complete(now) {
    return this.startedAt !== null && this.elapsed(now) >= this.duration;
  }

  stalled(now, timeout = 2500) {
    return this.lastFrameAt !== null && now - this.lastFrameAt > timeout;
  }

  get capturedSeconds() {
    return this.startedAt === null ? 0 : (this.lastFrameAt - this.startedAt) / 1000;
  }
}
