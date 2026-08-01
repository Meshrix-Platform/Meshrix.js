import { browserWindow } from "./browser-window";

type ConsoleWindowEventListener<T> = (detail: T, event: CustomEvent<T>) => void;

export function createConsoleWindowEventChannel<T>(eventName: string) : any {
  function dispatch(detail: T) : any {
    const browser: any = browserWindow();
    if (!browser) {
      return;
    }
    browser.dispatchEvent(new CustomEvent<T>(eventName, { detail }));
  }

  function add(listener: ConsoleWindowEventListener<T>) : any {
    const browser: any = browserWindow();
    if (!browser) {
      return () : any => {};
    }

    const eventListener: any = (event: Event) : any => {
      listener((event as CustomEvent<T>).detail, event as CustomEvent<T>);
    };
    browser.addEventListener(eventName, eventListener);
    return () : any => browser.removeEventListener(eventName, eventListener);
  }

  return {
    add,
    dispatch,
    eventName,
  };
}
