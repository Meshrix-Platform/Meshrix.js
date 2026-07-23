import { browserWindow } from "./browser-window";

type ConsoleWindowEventListener<T> = (detail: T, event: CustomEvent<T>) => void;

export function createConsoleWindowEventChannel<T>(eventName: string) {
  function dispatch(detail: T) {
    const browser = browserWindow();
    if (!browser) {
      return;
    }
    browser.dispatchEvent(new CustomEvent<T>(eventName, { detail }));
  }

  function add(listener: ConsoleWindowEventListener<T>) {
    const browser = browserWindow();
    if (!browser) {
      return () => {};
    }

    const eventListener = (event: Event) => {
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
