import { useEffect, useRef, useSyncExternalStore } from "react";
import { onThemeApplied, setTelegramScheme, THEME_BACKGROUND } from "./theme";

/**
 * Telegram opens a Mini App with its launch data in the fragment of the address (#tgWebAppData=...). That is all the
 * app needs to sign in. Inside Telegram (and only there) the official script telegram-web-app.js is loaded as well, for
 * what the app asks of Telegram: the whole screen (Fullscreen), the margins of Telegram's buttons, the back button,
 * no closing by a swipe down, the colors of the bars, a question before closing while entries wait on the phone. Without
 * the script (no connection when the app opened) the app still works, with Telegram's ordinary header.
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

type Inset = { top: number; bottom: number; left: number; right: number };

/** What the app uses of window.Telegram.WebApp (the script describes much more). */
type WebApp = {
  platform: string;
  colorScheme: "light" | "dark";
  isFullscreen?: boolean;
  safeAreaInset?: Inset;
  contentSafeAreaInset?: Inset;
  isVersionAtLeast: (version: string) => boolean;
  ready: () => void;
  expand: () => void;
  requestFullscreen?: () => void;
  disableVerticalSwipes?: () => void;
  setHeaderColor: (color: string) => void;
  setBackgroundColor: (color: string) => void;
  setBottomBarColor?: (color: string) => void;
  enableClosingConfirmation: () => void;
  disableClosingConfirmation: () => void;
  onEvent: (event: string, handler: () => void) => void;
  BackButton: { show: () => void; hide: () => void; onClick: (handler: () => void) => void; offClick: (handler: () => void) => void };
};

const SCRIPT = "https://telegram.org/js/telegram-web-app.js";
let webApp: WebApp | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Telegram's WebApp once the script is there (null before, and outside Telegram). */
function useWebApp(): WebApp | null {
  return useSyncExternalStore(subscribe, () => webApp);
}

const telegramWebApp = () => (window as unknown as { Telegram?: { WebApp?: WebApp } }).Telegram?.WebApp;

type Bridge = { postEvent?: (type: string, data: string) => void };

/** A message to Telegram without the script: what is needed when the script could not be loaded. */
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

/** The margins Telegram asks for in full screen: its own buttons at the top, the phone's bars, as CSS variables. */
function placeMargins(app: WebApp) {
  const root = document.documentElement;
  const full = app.isFullscreen === true;
  root.classList.toggle("tg-fullscreen", full);
  const none = { top: 0, bottom: 0, left: 0, right: 0 };
  const safe = app.safeAreaInset ?? none;
  const content = app.contentSafeAreaInset ?? none;
  root.style.setProperty("--tg-safe-top", `${full ? safe.top : 0}px`);
  root.style.setProperty("--tg-content-top", `${full ? content.top : 0}px`);
  root.style.setProperty("--tg-safe-bottom", `${safe.bottom}px`);
  root.style.setProperty("--tg-content-bottom", `${content.bottom}px`);
}

/** Telegram's script is there: the whole screen on a phone, the margins, the colors, the theme. */
function started(app: WebApp) {
  webApp = app;
  document.documentElement.classList.add("tg-app");
  app.ready();
  app.expand();
  const phone = ["ios", "android", "android_x"].includes(app.platform);
  if (phone && app.isVersionAtLeast("8.0")) app.requestFullscreen?.();
  // A swipe down scrolls the page; it does not close the app.
  if (app.isVersionAtLeast("7.7")) app.disableVerticalSwipes?.();
  placeMargins(app);
  for (const event of ["safeAreaChanged", "contentSafeAreaChanged", "fullscreenChanged", "viewportChanged"]) {
    app.onEvent(event, () => placeMargins(app));
  }
  setTelegramScheme(app.colorScheme);
  app.onEvent("themeChanged", () => setTelegramScheme(app.colorScheme));
  // Telegram's bars in the color of the page, in either theme.
  onThemeApplied((dark) => {
    const color = dark ? THEME_BACKGROUND.dark : THEME_BACKGROUND.light;
    try {
      app.setHeaderColor(color);
      app.setBackgroundColor(color);
      if (app.isVersionAtLeast("7.10")) app.setBottomBarColor?.(color);
    } catch {
      // an older Telegram: its own colors
    }
  });
  listeners.forEach((listener) => listener());
}

/** Inside Telegram: loads the official script, then sets the app up. Outside Telegram: nothing. */
export function startTelegram() {
  if (!inTelegram() || webApp) return;
  const existing = telegramWebApp();
  if (existing) {
    started(existing);
    return;
  }
  const script = document.createElement("script");
  script.src = SCRIPT;
  script.async = true;
  script.onload = () => {
    const app = telegramWebApp();
    if (app) started(app);
    else tellTelegramReady();
  };
  // No connection to telegram.org: the app is shown all the same, with Telegram's ordinary header.
  script.onerror = () => tellTelegramReady();
  document.head.appendChild(script);
}

/** Tells Telegram that the app is ready to be shown, and asks for the whole height of the window (without the script). */
export function tellTelegramReady() {
  post("web_app_ready", {});
  post("web_app_expand", {});
}

/** Telegram's own back button (at the top left), while a section opened from «Настройки» is shown. */
export function useTelegramBackButton(onBack: (() => void) | undefined) {
  const app = useWebApp();
  const latest = useRef(onBack);
  latest.current = onBack;
  const shown = onBack !== undefined;
  useEffect(() => {
    if (!app) return;
    if (!shown) {
      app.BackButton.hide();
      return;
    }
    const pressed = () => latest.current?.();
    app.BackButton.onClick(pressed);
    app.BackButton.show();
    return () => {
      app.BackButton.offClick(pressed);
      app.BackButton.hide();
    };
  }, [app, shown]);
}

/** While entries wait on the phone, Telegram asks before the app is closed (they would go out only at the next opening). */
export function useTelegramClosingConfirmation(needed: boolean) {
  const app = useWebApp();
  useEffect(() => {
    if (!app) return;
    if (needed) app.enableClosingConfirmation();
    else app.disableClosingConfirmation();
  }, [app, needed]);
}
