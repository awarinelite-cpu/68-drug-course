import { useEffect, useRef, useState } from "react";

const REARM_WINDOW_MS = 2000;

// Home is the top of the in-app navigation stack, so hardware/OS Back here
// shouldn't do anything by default — but it also shouldn't silently fall
// through to whatever real browser history happens to sit underneath all
// the replaced entries every other page's useBackLock has been leaving
// behind. Instead: first press arms a short window and tells the caller to
// show a "Press back again to exit" message; a second press inside that
// window exits the app. Mirrors useBackLock's push+popstate technique so it
// keeps working no matter how Home was actually reached.
export function useExitOnDoubleBack() {
  const [showToast, setShowToast] = useState(false);
  const armedRef = useRef(false);
  const timerRef = useRef(null);

  useEffect(() => {
    try {
      window.history.pushState({ __backGuard: true }, "", window.location.href);
    } catch (e) { /* ignore (e.g. sandboxed preview) */ }

    const onPopState = () => {
      // Re-arm the guard immediately so it's never "used up" — every press
      // from here on keeps landing back on this same handler rather than
      // escaping to whatever's underneath.
      try {
        window.history.pushState({ __backGuard: true }, "", window.location.href);
      } catch (e) { /* ignore */ }

      if (armedRef.current) {
        clearTimeout(timerRef.current);
        armedRef.current = false;
        setShowToast(false);
        exitApp();
        return;
      }
      armedRef.current = true;
      setShowToast(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        armedRef.current = false;
        setShowToast(false);
      }, REARM_WINDOW_MS);
    };

    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      clearTimeout(timerRef.current);
    };
  }, []);

  return showToast;
}

async function exitApp() {
  try {
    const { App } = await import("@capacitor/app");
    if (App && typeof App.exitApp === 'function') App.exitApp();
  } catch (e) {
    // Not running under Capacitor (e.g. plain browser/preview) — nothing to exit.
  }
}
