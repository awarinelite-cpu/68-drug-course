import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

// Makes the browser/device Back button always return to a known route, no
// matter how the current page was reached — a direct link, a bookmark, a
// refresh, or several pages of in-app navigation.
//
// How it works: we push one extra history entry for the current page, then
// listen for popstate (fired on Back/Forward). The first Back press consumes
// that extra entry and lands us in this handler instead of wherever browser
// history would naturally have gone, so we can force the navigation to
// targetPath ourselves.
export function useBackLock(targetPath) {
  const navigate = useNavigate();

  useEffect(() => {
    try {
      window.history.pushState({ __backGuard: true }, "", window.location.href);
    } catch (e) { /* ignore (e.g. sandboxed preview) */ }

    const onPopState = () => navigate(targetPath, { replace: true });
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetPath]);
}
