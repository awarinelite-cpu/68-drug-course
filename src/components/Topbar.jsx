import { useEffect, useState } from "react";
import { useNav } from "../contexts/NavContext.jsx";
import { useTheme } from "../contexts/ThemeContext.jsx";

// Wallpaper design rotates every 2 minutes (7 designs, driven by the clock so
// it stays in step across pages).
const WP_COUNT = 7, WP_MS = 120000;
const wpIndex = () => Math.floor(Date.now() / WP_MS) % WP_COUNT;

export default function Topbar({ brand, identity, children }) {
  const { openDrawer } = useNav();
  const themeCtx = useTheme();
  const [wp, setWp] = useState(wpIndex);
  useEffect(() => {
    const t = setInterval(() => setWp(wpIndex()), 5000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="topbar" data-wp={wp}>
      <div className="gnav-topbar-left no-print">
        <div className="gnav-topbar-left-row">
          <button className="gnav-toggle" aria-label="Open menu" onClick={openDrawer}>&#9776;</button>
          <div className="brand">{brand}</div>
        </div>
        {identity && <div className="topbar-identity topbar-identity--below no-print">{identity}</div>}
      </div>
      <div className="right">
        {themeCtx && (
          <button
            className="theme-toggle-btn no-print"
            type="button"
            aria-label="Toggle dark mode"
            onClick={themeCtx.toggleTheme}
          >
            {themeCtx.theme === "dark" ? "🌙 Night" : "☀️ Day"}
          </button>
        )}
        {identity && <div className="topbar-identity topbar-identity--inline no-print">{identity}</div>}
        {children}
      </div>
    </div>
  );
}
