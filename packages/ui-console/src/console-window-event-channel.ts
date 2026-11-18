import { browserWindow } from "./browser-window";

export type ConsoleWindowEventListener<T> = (detail: T, event: CustomEvent<T>) => void;

export type ConsoleWindowEventChannel<T> = {
  add(listener: ConsoleWindowEventListener<T>): () => void;
  dispatch(detail: T): void;
  eventName: string;
};

export function createConsoleWindowEventChannel<T>(eventName: string): ConsoleWindowEventChannel<T> {
  function dispatch(detail: T): void {
    const browser = browserWindow();
    if (!browser) {
      return;
    }
    browser.dispatchEvent(new CustomEvent<T>(eventName, { detail }));
  }

  function add(listener: ConsoleWindowEventListener<T>): () => void {
    const browser = browserWindow();
    if (!browser) {
      return () => {};
    }

    const eventListener = (event: Event): void => {
      listener((event as CustomEvent<T>).detail, event as CustomEvent<T>);
    };
    browser.addEventListener(eventName, eventListener);
    return () => browser.removeEventListener(eventName, eventListener);
  }

  return {
    add,
    dispatch,
    eventName,
  };
}
