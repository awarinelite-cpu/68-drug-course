import { useEffect, useState } from "react";
import narhyLogo from "../assets/narhy-logo.png";
import buildingPhoto from "../assets/narhy-building.jpg";
import { useNavigate } from "react-router-dom";
import { useNav } from "../contexts/NavContext.jsx";
import { useTheme } from "../contexts/ThemeContext.jsx";
import { getViewMode, toggleViewMode } from "../lib/viewMode.js";
import { avatarMarkup } from "../lib/avatar.js";
import { formatShortNameTag } from "../lib/roles.js";

const S = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" };

function Logo() {
  return <img className="wh-logo" src={narhyLogo} alt="68 NARHY" width="52" height="52" />;
}

// The real 68 NARHY building, faded into the right side of the header.
function BuildingArt() {
  return <img className="wh-art" src={buildingPhoto} alt="" aria-hidden="true" />;
}

export default function WardHeader({ profile, myWard, incomingCount, onOpenTransfers }) {
  const navigate = useNavigate();
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
  const go = (path) => (e) => { e.preventDefault(); navigate(path); };

  return (
    <header className="wh-header no-print">
      <BuildingArt />
      <div className="wh-header-inner">
        <div className="wh-row1">
          <button className="wh-circle" type="button" aria-label="Open menu" onClick={openDrawer}>
            <svg width="22" height="22" viewBox="0 0 24 24" {...S} strokeWidth={2.4}><line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17" x2="20" y2="17" /></svg>
          </button>
          <div className="wh-brand">
            <Logo />
            <div className="wh-brand-text"><span className="wh-brand-1">68 NARHY</span><span className="wh-brand-2">Ward Charts</span></div>
          </div>
          <a
            className={"wh-wardpill" + (myWard ? "" : " wh-wardpill--attn")}
            href="/select-ward"
            title={myWard ? "Switch ward (" + myWard + ")" : "Set your ward"}
            onClick={go("/select-ward")}
          >
            <i className="wh-dot" />
            <span>{myWard ? "Ward" : "Set ward"}</span>
            <svg width="14" height="14" viewBox="0 0 24 24" {...S} strokeWidth={3}><polyline points="6 9 12 15 18 9" /></svg>
          </a>
        </div>

        <div className="wh-pills">
          {profile?.role === "admin" && (
            <a href="/admin" className="wh-pill" onClick={go("/admin")}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="#c084fc"><circle cx="12" cy="8" r="4.5" /><path d="M3.5 21c0-4.7 3.8-8 8.5-8s8.5 3.3 8.5 8z" /></svg>
              Admin
            </a>
          )}
          <a href="/my-patients" className="wh-pill" onClick={go("/my-patients")}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff"><circle cx="12" cy="8" r="4.5" /><path d="M3.5 21c0-4.7 3.8-8 8.5-8s8.5 3.3 8.5 8z" /></svg>
            My Patients
          </a>
          {myWard && (
            <a href="#" className="wh-pill notif-bell-btn" onClick={(e) => { e.preventDefault(); onOpenTransfers(); }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="#fbbf24"><path d="M12 2.5a6 6 0 0 0-6 6v4l-2 3.5h16L18 12.5v-4a6 6 0 0 0-6-6z" /><path d="M9.5 19a2.5 2.5 0 0 0 5 0z" /></svg>
              New Patient
              {incomingCount > 0 && <span className="notif-count-badge">{incomingCount}</span>}
            </a>
          )}
          <span className="wh-tools">
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
            <a
              className="wh-icon wh-icon--me"
              href="/profile"
              title={profile ? formatShortNameTag(profile.name, profile.role) : "Profile"}
              aria-label="Profile"
              onClick={go("/profile")}
            >
              <span dangerouslySetInnerHTML={{ __html: profile ? avatarMarkup(profile, 34) : "" }} />
            </a>
          </span>
        </div>
      </div>
    </header>
  );
}
