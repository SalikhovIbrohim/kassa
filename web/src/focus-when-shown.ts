/**
 * A ref for something that takes the focus when it appears. It has to be one function for good: a new one on
 * every render (an arrow written inline) would take the focus back from the buttons inside it each time the
 * screen is drawn again, for instance when the queue changes.
 */
export function focusWhenShown(node: HTMLElement | null) {
  node?.focus();
}
