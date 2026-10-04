import { useEffect } from "react";

// Sets the paper orientation used when printing the current page, and puts it
// back when the page unmounts (so other pages keep the browser default).
// Usage: usePrintOrientation('landscape') at the top of a printable page.
export default function usePrintOrientation(orientation = "landscape") {
  useEffect(() => {
    const el = document.createElement("style");
    el.setAttribute("data-print-orientation", orientation);
    el.textContent = "@media print { @page { size: " + orientation + "; margin: 8mm; } }";
    document.head.appendChild(el);
    return () => { if (el.parentNode) el.parentNode.removeChild(el); };
  }, [orientation]);
}
