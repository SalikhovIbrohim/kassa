/**
 * Telegram opens a Mini App with its launch data in the fragment of the address (#tgWebAppData=...). That is all
 * the app needs to sign in, so no script of Telegram's is loaded, from telegram.org or from anywhere else; the
 * two messages the app sends to Telegram (ready, and full height) are written out here.
 */
let launch: string | null | undefined;

/** The launch data that Telegram gave when it opened the app, or null when this is an ordinary browser. */
export function telegramLaunchData(): string | null {
  if (launch !== undefined) return launch;
  launch = null;
  try {
    const found = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("tgWebAppData");
    if (found) launch = found;
  } catch {
    // an address that cannot be read: an ordinary browser
  }
  return launch;
}

export const inTelegram = () => telegramLaunchData() !== null;

type Bridge = { postEvent?: (type: string, data: string) => void };

function post(eventType: string, eventData: Record<string, never>) {
  try {
    const proxy = (window as unknown as { TelegramWebviewProxy?: Bridge }).TelegramWebviewProxy;
    if (proxy?.postEvent) {
      proxy.postEvent(eventType, JSON.stringify(eventData));
      return;
    }
    const external = (window as unknown as { external?: { notify?: (message: string) => void } }).external;
    if (external && typeof external.notify === "function") {
      external.notify(JSON.stringify({ eventType, eventData }));
      return;
    }
    // Telegram for the web and some desktop versions show the app in a frame of their own page.
    if (window.parent !== window) window.parent.postMessage(JSON.stringify({ eventType, eventData }), "*");
  } catch {
    // Telegram not there: nothing to tell
  }
}

/** Tells Telegram that the app is ready to be shown, and asks for the whole height of the window. */
export function tellTelegramReady() {
  post("web_app_ready", {});
  post("web_app_expand", {});
}
