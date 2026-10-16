import { useNav } from "../contexts/NavContext.jsx";
import { useEffect, useState } from "react";
import { useTheme } from "../contexts/ThemeContext.jsx";
import { getViewMode, toggleViewMode } from "../lib/viewMode.js";

export default function Topbar({ brand, identity, children }) {
  const { openDrawer } = useNav();
  const themeCtx = useTheme();
  const [viewMode, setViewModeState] = useState(getViewMode);
  useEffect(() => {
    const onChange = (e) => setViewModeState(e.detail || getViewMode());
    window.addEventListener("view-mode-change", onChange);
    return () => window.removeEventListener("view-mode-change", onChange);
  }, []);
  const isDesktop = viewMode === "desktop";
  return (
    <div className="topbar">
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
        <button
          className="theme-toggle-btn view-mode-btn no-print"
          type="button"
          aria-label={isDesktop ? "Switch to mobile mode" : "Switch to desktop mode"}
          title={isDesktop ? "Switch to mobile mode" : "Switch to desktop mode"}
          onClick={toggleViewMode}
        >
          {isDesktop ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="7" y="2" width="10" height="20" rx="2" /><line x1="11" y1="18" x2="13" y2="18" /></svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></svg>
          )}
        </button>
        {identity && <div className="topbar-identity topbar-identity--inline no-print">{identity}</div>}
        {children}
      </div>
    </div>
  );
}
