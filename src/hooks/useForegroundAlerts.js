import { useEffect } from "react";
import { initForegroundAlertsIfEnabled } from "../lib/push.js";

// A page load with no listener registered means a foreground push arrives
// with nothing to catch it, silently — so this has to run on every page,
// not just the page where a nurse originally tapped "Alerts On".
export function useForegroundAlerts() {
  useEffect(() => {
    initForegroundAlertsIfEnabled().catch(() => {});
  }, []);
}
