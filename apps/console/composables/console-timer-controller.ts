import { ref, type Ref } from "vue";
import { browserWindow } from "../lib/browser-window";

type TimerCallback = () => void;

type TimerControllerOptions = {
  timer?: Ref<number | null>;
};

export function createConsoleIntervalController(options: TimerControllerOptions = {}) : any {
  const timer: any = options.timer || ref<number | null>(null);

  function stop() : any {
    const browser: any = browserWindow();
    if (browser && timer.value !== null) {
      browser.clearInterval(timer.value);
    }
    timer.value = null;
  }

  function start(callback: TimerCallback, intervalMs: number) : any {
    stop();
    const browser: any = browserWindow();
    if (!browser) {
      return null;
    }
    timer.value = browser.setInterval(callback, Math.max(0, intervalMs));
    return timer.value;
  }

  function current() : any {
    return timer.value;
  }

  return {
    current,
    start,
    stop,
    timer,
  };
}

export function createConsoleTimeoutController(options: TimerControllerOptions = {}) : any {
  const timer: any = options.timer || ref<number | null>(null);

  function stop() : any {
    const browser: any = browserWindow();
    if (browser && timer.value !== null) {
      browser.clearTimeout(timer.value);
    }
    timer.value = null;
  }

  function schedule(callback: TimerCallback, delayMs: number) : any {
    stop();
    const browser: any = browserWindow();
    if (!browser) {
      return null;
    }
    timer.value = browser.setTimeout(() : any => {
      timer.value = null;
      callback();
    }, Math.max(0, delayMs));
    return timer.value;
  }

  function current() : any {
    return timer.value;
  }

  return {
    current,
    schedule,
    stop,
    timer,
  };
}

export function waitForConsoleDelay(delayMs: number) : any {
  const browser: any = browserWindow();
  if (!browser) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve?: any) : any => {
    browser.setTimeout(resolve, Math.max(0, delayMs));
  });
}
