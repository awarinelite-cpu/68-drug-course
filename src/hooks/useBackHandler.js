import { useEffect, useRef } from "react";

// Page-owned Back behaviour for pages whose Back isn't "go to a fixed route"
// (Calculators, Lab Reference). Same push+popstate technique as useBackLock,
// so the topbar Back button (window.history.back()), the browser Back and the
// Android hardware button all land in ONE handler.
//
// The handler returns true when it handled Back inside the page (e.g. went
// from a calculator to the calculator hub) — the guard entry is re-armed so
// the next Back reaches the handler again. It returns false when it navigated
// away; the guard is deliberately NOT re-armed then, so the replace-navigation
// overwrites this page's history entry and Back never returns to it.
export function useBackHandler(handler) {
  const ref = useRef(handler);
  ref.current = handler;

  useEffect(() => {
    const arm = () => {
      try { window.history.pushState({ __backGuard: true }, "", window.location.href); } catch (e) { /* ignore */ }
    };
    arm();
    const onPopState = () => { if (ref.current()) arm(); };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
}
