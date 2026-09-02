import { useEffect, useState } from "react";

export default function OfflineBanner() {
  const [offline, setOffline] = useState(!navigator.onLine);

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  return (
    <div className={"gnav-offline-banner no-print" + (offline ? " gnav-show" : "")}>
      You're offline — entries are being saved on this device and will sync automatically once you're back online.
    </div>
  );
}
