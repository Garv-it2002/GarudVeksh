/**
 * Background Clock Dispatcher
 * Instantiates an unthrottled Web Worker so that factory physics tick at 500ms
 * even when the dashboard tab is running in the background.
 * Automatically falls back to standard setInterval in environments without Web Worker support.
 */

class BackgroundClock {
  constructor() {
    this._subscribers = new Set();
    this._worker = null;
    this._fallbackInterval = null;
    this._initWorker();
  }

  _initWorker() {
    if (typeof window !== 'undefined' && typeof Worker !== 'undefined') {
      try {
        // Create worker from blob to avoid external file path resolution issues
        const workerBlob = new Blob([`
          let timer = null;
          self.onmessage = function(e) {
            if (e.data === 'START') {
              if (timer) clearInterval(timer);
              timer = setInterval(() => self.postMessage('TICK'), 500);
            } else if (e.data === 'STOP') {
              if (timer) { clearInterval(timer); timer = null; }
            }
          };
        `], { type: 'application/javascript' });

        this._worker = new Worker(URL.createObjectURL(workerBlob));
        this._worker.onmessage = () => {
          this._subscribers.forEach(callback => {
            try { callback(); } catch (e) { console.error(e); }
          });
        };
        this._worker.postMessage('START');
        return;
      } catch (e) {
        console.warn('Web Worker initialization failed, falling back to setInterval:', e);
      }
    }

    // Fallback if workers are unavailable
    this._fallbackInterval = setInterval(() => {
      this._subscribers.forEach(callback => {
        try { callback(); } catch (e) { console.error(e); }
      });
    }, 500);
  }

  subscribe(callback) {
    this._subscribers.add(callback);
    return () => this._subscribers.delete(callback);
  }

  destroy() {
    if (this._worker) {
      this._worker.postMessage('STOP');
      this._worker.terminate();
      this._worker = null;
    }
    if (this._fallbackInterval) {
      clearInterval(this._fallbackInterval);
      this._fallbackInterval = null;
    }
    this._subscribers.clear();
  }
}

if (typeof window !== 'undefined') {
  window.backgroundClock = new BackgroundClock();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = BackgroundClock;
}
