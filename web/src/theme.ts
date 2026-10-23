import { useCallback, useEffect, useState } from "react";

/** Light, dark, or as the phone or the computer is set: the person chooses, and the device keeps the choice. */
export type ThemeChoice = "system" | "light" | "dark";

export const THEME_LABEL: Record<ThemeChoice, string> = { system: "Как в системе", light: "Светлая", dark: "Тёмная" };
export const THEME_CHOICES: readonly ThemeChoice[] = ["system", "light", "dark"];

const KEY = "kassa.theme";
// The color of the top of the browser (and of the status bar of an app put on the home screen), one for each theme.
const BAR_COLOR = { light: "#f7f8f9", dark: "#15171b" } as const;

function stored(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

const systemDark = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;

/** Puts the theme on the page: the class "dark" on <html>, and the color of the browser's bar. */
function apply(choice: ThemeChoice) {
  const dark = choice === "dark" || (choice === "system" && systemDark());
  document.documentElement.classList.toggle("dark", dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? BAR_COLOR.dark : BAR_COLOR.light);
}

/** Called once before the first screen is drawn, so that a dark theme does not flash white first. */
export function startTheme() {
  apply(stored());
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    if (stored() === "system") apply("system");
  });
}

/** The theme chosen on this device, and the way to change it. */
export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(stored);
  useEffect(() => apply(choice), [choice]);
  const choose = useCallback((next: ThemeChoice) => {
    try {
      if (next === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      // not kept: the next visit starts from the system's
    }
    setChoice(next);
  }, []);
  return [choice, choose];
}
