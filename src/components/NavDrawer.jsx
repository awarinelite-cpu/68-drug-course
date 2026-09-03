import { useNavigate, useSearchParams } from "react-router-dom";
import { useNav } from "../contexts/NavContext.jsx";
import { useAuth } from "../contexts/AuthContext.jsx";

// Falls back to the currently selected patient (stored by Home in
// sessionStorage) so the Overview link still works from the home page, where
// the selection lives in session storage rather than the URL.
function getActivePatientId(searchParams) {
  return searchParams.get("patient") || sessionStorage.getItem("selectedPatientId");
}

export default function NavDrawer() {
  const { open, closeDrawer } = useNav();
  const { profile, logout } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const patientId = getActivePatientId(searchParams);
  const overviewHref = patientId ? "/charts/overview?patient=" + encodeURIComponent(patientId) : null;

  function go(path) {
    closeDrawer();
    navigate(path);
  }

  async function handleLogout() {
    closeDrawer();
    await logout();
    navigate("/login");
  }

  function handleSearch() {
    closeDrawer();
    if (window.location.pathname === "/") {
      const input = document.getElementById("searchInput");
      if (input) { input.scrollIntoView({ behavior: "smooth", block: "center" }); input.focus(); }
    } else {
      navigate("/#search");
    }
  }

  return (
    <>
      <div className={"gnav-overlay no-print" + (open ? " gnav-open" : "")} onClick={closeDrawer} />
      <div className={"gnav-drawer no-print" + (open ? " gnav-open" : "")}>
        <div className="gnav-drawer-head">
          <span>68 NARHY Ward Charts</span>
          <button className="gnav-drawer-close" aria-label="Close menu" onClick={closeDrawer}>&times;</button>
        </div>
        <div className="gnav-who">{profile ? profile.name + " (" + profile.role + ")" : ""}</div>
        <div className="gnav-drawer-body">
          <button className="gnav-link" onClick={() => go("/")}><span className="gnav-icon">&#127968;</span>Home</button>
          <button className="gnav-link" onClick={handleSearch}><span className="gnav-icon">&#128269;</span>Search</button>
          <button
            className={"gnav-link" + (overviewHref ? "" : " gnav-disabled")}
            onClick={() => overviewHref && go(overviewHref)}
          >
            <span className="gnav-icon">&#128203;</span>Overview
          </button>
          <button className="gnav-link" onClick={() => go("/profile")}><span className="gnav-icon">&#128100;</span>My Profile</button>
          <button className="gnav-link" onClick={() => go("/my-patients")}><span className="gnav-icon">&#128101;</span>My Patients</button>
          <button className="gnav-link" onClick={() => go("/community")}><span className="gnav-icon">&#128172;</span>Community</button>
          <button className="gnav-link" onClick={() => go("/messages")}><span className="gnav-icon">&#128172;</span>Messages</button>
          <button className="gnav-link" onClick={() => go("/nurses-report/role-select")}><span className="gnav-icon">&#128203;</span>Nurses Report</button>
          <button className="gnav-link" onClick={() => go(patientId ? "/charts/calculators?patient=" + encodeURIComponent(patientId) : "/charts/calculators")}><span className="gnav-icon">&#129518;</span>Calculators</button>
          <button className="gnav-link" onClick={() => go("/charts/lab-reference")}><span className="gnav-icon">&#128300;</span>Lab Reference</button>
          {profile?.role === "admin" && (
            <button className="gnav-link" onClick={() => go("/admin")}><span className="gnav-icon">&#9881;&#65039;</span>Admin</button>
          )}
        </div>
        <div className="gnav-drawer-foot">
          <button className="gnav-link" onClick={handleLogout}><span className="gnav-icon">&#128682;</span>Log Out</button>
        </div>
      </div>
    </>
  );
}
