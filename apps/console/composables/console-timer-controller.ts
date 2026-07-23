import { ref, type Ref } from "vue";
import { browserWindow } from "../lib/browser-window";

type TimerCallback = () => void;

type TimerControllerOptions = {
  timer?: Ref<number | null>;
};

export function createConsoleIntervalController(options: TimerControllerOptions = {}) {
  const timer = options.timer || ref<number | null>(null);

  function stop() {
    const browser = browserWindow();
    if (browser && timer.value !== null) {
      browser.clearInterval(timer.value);
    }
    timer.value = null;
  }

  function start(callback: TimerCallback, intervalMs: number) {
    stop();
    const browser = browserWindow();
    if (!browser) {
      return null;
    }
    timer.value = browser.setInterval(callback, Math.max(0, intervalMs));
    return timer.value;
  }

  function current() {
    return timer.value;
  }

  return {
    current,
    start,
    stop,
    timer,
  };
}

export function createConsoleTimeoutController(options: TimerControllerOptions = {}) {
  const timer = options.timer || ref<number | null>(null);

  function stop() {
    const browser = browserWindow();
    if (browser && timer.value !== null) {
      browser.clearTimeout(timer.value);
    }
    timer.value = null;
  }

  function schedule(callback: TimerCallback, delayMs: number) {
    stop();
    const browser = browserWindow();
    if (!browser) {
      return null;
    }
    timer.value = browser.setTimeout(() => {
      timer.value = null;
      callback();
    }, Math.max(0, delayMs));
    return timer.value;
  }

  function current() {
    return timer.value;
  }

  return {
    current,
    schedule,
    stop,
    timer,
  };
}

export function waitForConsoleDelay(delayMs: number) {
  const browser = browserWindow();
  if (!browser) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    browser.setTimeout(resolve, Math.max(0, delayMs));
  });
}
