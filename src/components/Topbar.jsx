import { useNav } from "../contexts/NavContext.jsx";
import { useEffect, useState } from "react";
import narhyLogo from "../assets/narhy-logo.png";
import { useTheme } from "../contexts/ThemeContext.jsx";
import { getViewMode, toggleViewMode } from "../lib/viewMode.js";

const S = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" };

function Logo() {
  return <img className="wh-logo" src={narhyLogo} alt="68 NARHY" width="52" height="52" />;
}

// Shared page header (same look as the ward home header): hamburger, logo +
// "68 NARHY / <page title>", then the page's own action buttons as pills with
// small day/night and desktop-mode icons at the end.
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
  const dark = themeCtx && themeCtx.theme === "dark";
  const raw = String(brand || "");
  const title = raw.includes(" — ") ? raw.split(" — ").slice(1).join(" — ") : raw.replace(/^68 NARHY\s*/i, "") || raw;
  const long = title.length > 18;
  return (
    <header className="wh-header wh-header--page no-print">
      <div className="wh-header-inner">
        <div className="wh-row1">
          <button className="wh-circle" type="button" aria-label="Open menu" onClick={openDrawer}>
            <svg width="22" height="22" viewBox="0 0 24 24" {...S} strokeWidth={2.4}><line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17" x2="20" y2="17" /></svg>
          </button>
          <div className="wh-brand">
            <Logo />
            <div className="wh-brand-text">
              <span className="wh-brand-1">68 NARHY</span>
              <span className={"wh-brand-2" + (long ? " wh-brand-2--long" : "")}>{title}</span>
            </div>
          </div>
          <span className="wh-tools wh-tools--top">
            {themeCtx && (
              <button className="wh-icon" type="button" aria-label="Toggle dark mode" title={dark ? "Night mode — tap for day" : "Day mode — tap for night"} onClick={themeCtx.toggleTheme}>
                {dark ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" {...S}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" {...S} stroke="#fbbf24"><circle cx="12" cy="12" r="4" fill="#fbbf24" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
                )}
              </button>
            )}
            <button
              className="wh-icon"
              type="button"
              aria-label={isDesktop ? "Switch to mobile mode" : "Switch to desktop mode"}
              title={isDesktop ? "Switch to mobile mode" : "Switch to desktop mode"}
              onClick={toggleViewMode}
            >
              {isDesktop ? (
                <svg width="18" height="18" viewBox="0 0 24 24" {...S}><rect x="7" y="2" width="10" height="20" rx="2" /><line x1="11" y1="18" x2="13" y2="18" /></svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" {...S}><rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></svg>
              )}
            </button>
          </span>
        </div>
        {(identity || children) && (
          <div className="wh-pills">
            {identity && <div className="wh-identity">{identity}</div>}
            {children}
          </div>
        )}
      </div>
    </header>
  );
}
