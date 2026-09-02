import { useNav } from "../contexts/NavContext.jsx";

export default function Topbar({ brand, children }) {
  const { openDrawer } = useNav();
  return (
    <div className="topbar">
      <div className="gnav-topbar-left no-print">
        <button className="gnav-toggle" aria-label="Open menu" onClick={openDrawer}>&#9776;</button>
        <div className="brand">{brand}</div>
      </div>
      <div className="right">{children}</div>
    </div>
  );
}
