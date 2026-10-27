// Reconnect backoff: 0.5 s, 1 s, 2 s, 4 s, then 5 s forever; reset after a good hello.

/** @typedef {{ minMs?: number, maxMs?: number }} BackoffOptions */

/** @param {number} attempt @param {BackoffOptions} [opts] @returns {number} */
export function backoffDelay(attempt, { minMs = 500, maxMs = 5000 } = {}) {
  if (!(attempt >= 0)) return minMs;
  return Math.min(maxMs, minMs * 2 ** Math.min(attempt, 20));
}

export class Backoff {
  /** @param {BackoffOptions} [opts] */
  constructor(opts = {}) {
    this.opts = opts;
    this.attempt = 0;
  }

  next() {
    return backoffDelay(this.attempt++, this.opts);
  }

  reset() {
    this.attempt = 0;
  }
}
