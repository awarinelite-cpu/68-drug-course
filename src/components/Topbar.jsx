import { useNav } from "../contexts/NavContext.jsx";
import { useTheme } from "../contexts/ThemeContext.jsx";

export default function Topbar({ brand, children }) {
  const { openDrawer } = useNav();
  const themeCtx = useTheme();
  return (
    <div className="topbar">
      <div className="gnav-topbar-left no-print">
        <button className="gnav-toggle" aria-label="Open menu" onClick={openDrawer}>&#9776;</button>
        <div className="brand">{brand}</div>
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
        {children}
      </div>
    </div>
  );
}
