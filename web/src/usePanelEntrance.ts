import { useEffect, useRef } from "react";

/**
 * What a panel that opens under a row does for the person who opened it: it comes into view
 * (a tall form under a button at the bottom of a phone screen would otherwise open out of
 * sight) and keyboard and screen reader users are taken to its heading. Attach `root` to the
 * panel and `heading` to its heading, which gets tabIndex -1.
 */
export function usePanelEntrance<Root extends HTMLElement>() {
  const root = useRef<Root>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    root.current?.scrollIntoView?.({ block: "nearest" });
    heading.current?.focus({ preventScroll: true });
  }, []);

  return { root, heading };
}
