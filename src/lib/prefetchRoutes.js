// Quietly fetches every lazy-loaded page chunk in the background once the
// browser is idle, so navigating to any route later is instant (served
// from cache) instead of triggering a fresh download.
//
// This does NOT change total data usage — the same chunks still get
// downloaded eventually. It just moves the download earlier (while the
// user is reading the current page) instead of on-demand (when they tap
// a link and have to wait).
//
// On a slow/metered connection we skip background prefetching entirely,
// since on 2G/3G it's better to only load what's actually requested and
// not compete with the user's own navigation.

const routeImporters = [
  () => import("../pages/Home.jsx"),
  () => import("../pages/Patient.jsx"),
  () => import("../pages/MyPatients.jsx"),
  () => import("../pages/Profile.jsx"),
  () => import("../pages/Admin.jsx"),
  () => import("../pages/Overview.jsx"),
  () => import("../pages/Admission.jsx"),
  () => import("../pages/DrugCourseChart.jsx"),
  () => import("../pages/Vitals.jsx"),
  () => import("../pages/BloodGlucose.jsx"),
  () => import("../pages/IntakeOutput.jsx"),
  () => import("../pages/Seizure.jsx"),
  () => import("../pages/Calculators.jsx"),
  () => import("../pages/LabReference.jsx"),
  () => import("../pages/nurses-report/RoleSelect.jsx"),
  () => import("../pages/nurses-report/Analytics.jsx"),
  () => import("../pages/nurses-report/WardNurse.jsx"),
  () => import("../pages/nurses-report/OverallNurse.jsx"),
  () => import("../pages/nurses-report/ArchiveList.jsx"),
  () => import("../pages/nurses-report/ArchiveView.jsx"),
];

function isSlowConnection() {
  const conn =
    typeof navigator !== "undefined" &&
    (navigator.connection || navigator.mozConnection || navigator.webkitConnection);
  if (!conn) return false;
  if (conn.saveData) return true;
  return conn.effectiveType === "slow-2g" || conn.effectiveType === "2g";
}

let hasRun = false;

export function prefetchRoutes() {
  if (hasRun) return;
  hasRun = true;

  if (isSlowConnection()) return;

  const requestIdle =
    (typeof window !== "undefined" && window.requestIdleCallback) ||
    ((cb) => setTimeout(cb, 2000));

  requestIdle(() => {
    // Stagger slightly so we're never firing 20 fetches in one tick —
    // gentler on low-end devices and mobile data.
    routeImporters.forEach((importPage, i) => {
      setTimeout(() => {
        importPage().catch(() => {
          // A prefetch failing (e.g. offline) is harmless — the normal
          // lazy import will just retry when the route is actually visited.
        });
      }, i * 150);
    });
  });
}
