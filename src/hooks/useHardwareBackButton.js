import { useEffect } from "react";

// Capacitor's native Android back button, left unhandled, falls straight
// through to the OS default (finish the activity) instead of stepping back
// through the WebView's history. That's why it can jump straight to exiting
// the app from a page like Patient, while Home happens to behave — it
// depends on how many history entries are stacked at that moment, not on
// the page's own back logic.
//
// Every page already drives its back behavior off popstate (useBackLock,
// useExitOnDoubleBack), so the fix is to make the hardware button always
// issue a plain history.back() and let those existing handlers decide what
// happens, all the way down to Home's "press again to exit" prompt.
export function useHardwareBackButton() {
  useEffect(() => {
    let handle;
    let cancelled = false;
    (async () => {
      try {
        const { App } = await import("@capacitor/app");
        const h = await App.addListener("backButton", () => {
          window.history.back();
        });
        if (cancelled) h.remove();
        else handle = h;
      } catch (e) {
        // Not running under Capacitor (e.g. plain browser/preview) — nothing to wire up.
      }
    })();
    return () => {
      cancelled = true;
      if (handle) handle.remove();
    };
  }, []);
}
