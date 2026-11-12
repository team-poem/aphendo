import { useEffect, useRef, type RefObject } from "react";

// Close handlers of the open popups, topmost last. One listener so Esc only ever closes the top one.
const stack: (() => void)[] = [];
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !stack.length) return;
  e.preventDefault();
  stack[stack.length - 1]();
});

/** Registers a popup: Esc closes it only while it is on top. With `ref`, focus moves into it on open and
 *  returns to whatever had it on close; a hover card passes no ref so it never steals focus. */
export function useLayer(onClose: () => void, ref?: RefObject<HTMLElement | null>) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const back = ref && (document.activeElement as HTMLElement | null);
    const fn = () => close.current();
    stack.push(fn);
    const el = ref?.current;
    if (el && !el.contains(document.activeElement)) {
      const first = ["[data-autofocus]", "input:not([type=checkbox]), textarea, select", "button"].map((q) => el.querySelector<HTMLElement>(q)).find(Boolean);
      (first ?? el).focus();
    }
    return () => {
      stack.splice(stack.lastIndexOf(fn), 1);
      if (back?.isConnected) back.focus();
    };
  }, []);
}
