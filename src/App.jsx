import { lazy, Suspense, useEffect } from "react";
import { Routes, Route } from "react-router-dom";
import { AuthProvider } from "./contexts/AuthContext.jsx";
import { NavProvider } from "./contexts/NavContext.jsx";
import { ThemeProvider } from "./contexts/ThemeContext.jsx";
import RequireAuth from "./components/RequireAuth.jsx";
import NavDrawer from "./components/NavDrawer.jsx";
import OfflineBanner from "./components/OfflineBanner.jsx";
import OfflineCacheStatus from "./components/OfflineCacheStatus.jsx";
import PageLoading from "./components/PageLoading.jsx";
import { useServiceWorker } from "./hooks/useServiceWorker.js";
import { useForegroundAlerts } from "./hooks/useForegroundAlerts.js";
import { useHardwareBackButton } from "./hooks/useHardwareBackButton.js";
import { prefetchRoutes } from "./lib/prefetchRoutes.js";

// Login stays eager: it's the first thing an unauthenticated user sees,
// so there's no benefit to splitting it out and it avoids a loading
// flicker on the very first screen.
import Login from "./pages/Login.jsx";

// Everything else is lazy-loaded: Vite splits each into its own chunk,
// so the initial bundle only contains the app shell. prefetchRoutes()
// (called below, on idle) then quietly fetches these chunks in the
// background so navigating to them later is instant.
const Home = lazy(() => import("./pages/Home.jsx"));
const Patient = lazy(() => import("./pages/Patient.jsx"));
const MyPatients = lazy(() => import("./pages/MyPatients.jsx"));
const Profile = lazy(() => import("./pages/Profile.jsx"));
const Admin = lazy(() => import("./pages/Admin.jsx"));
const Overview = lazy(() => import("./pages/Overview.jsx"));
const Admission = lazy(() => import("./pages/Admission.jsx"));
const DrugCourseChart = lazy(() => import("./pages/DrugCourseChart.jsx"));
const Vitals = lazy(() => import("./pages/Vitals.jsx"));
const BloodGlucose = lazy(() => import("./pages/BloodGlucose.jsx"));
const IntakeOutput = lazy(() => import("./pages/IntakeOutput.jsx"));
const Seizure = lazy(() => import("./pages/Seizure.jsx"));
const Calculators = lazy(() => import("./pages/Calculators.jsx"));
const LabReference = lazy(() => import("./pages/LabReference.jsx"));
const RoleSelect = lazy(() => import("./pages/nurses-report/RoleSelect.jsx"));
const Analytics = lazy(() => import("./pages/nurses-report/Analytics.jsx"));
const WardNurse = lazy(() => import("./pages/nurses-report/WardNurse.jsx"));
const OverallNurse = lazy(() => import("./pages/nurses-report/OverallNurse.jsx"));
const ArchiveList = lazy(() => import("./pages/nurses-report/ArchiveList.jsx"));
const ArchiveView = lazy(() => import("./pages/nurses-report/ArchiveView.jsx"));

function AuthedShell({ children }) {
  return (
    <RequireAuth>
      <NavDrawer />
      {children}
    </RequireAuth>
  );
}

export default function App() {
  useServiceWorker();
  useForegroundAlerts();
  useHardwareBackButton();

  // Once the shell has mounted and the current page is showing, quietly
  // fetch the rest of the route chunks in the background (only when the
  // main thread is idle, so it never competes with the initial render).
  // By the time the user taps into another page, it's already cached.
  useEffect(() => {
    prefetchRoutes();
  }, []);

  return (
    <ThemeProvider>
    <AuthProvider>
      <NavProvider>
        <OfflineBanner />
        <OfflineCacheStatus />
        <Suspense fallback={<PageLoading />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<AuthedShell><Home /></AuthedShell>} />
          <Route path="/patient" element={<AuthedShell><Patient /></AuthedShell>} />
          <Route path="/my-patients" element={<AuthedShell><MyPatients /></AuthedShell>} />
          <Route path="/profile" element={<AuthedShell><Profile /></AuthedShell>} />
          <Route path="/admin" element={<AuthedShell><Admin /></AuthedShell>} />
          <Route path="/charts/overview" element={<AuthedShell><Overview /></AuthedShell>} />
          <Route path="/charts/admission" element={<AuthedShell><Admission /></AuthedShell>} />
          <Route path="/charts/drug-course-chart" element={<AuthedShell><DrugCourseChart /></AuthedShell>} />
          <Route path="/charts/vitals" element={<AuthedShell><Vitals /></AuthedShell>} />
          <Route path="/charts/blood-glucose" element={<AuthedShell><BloodGlucose /></AuthedShell>} />
          <Route path="/charts/intake-output" element={<AuthedShell><IntakeOutput /></AuthedShell>} />
          <Route path="/charts/seizure" element={<AuthedShell><Seizure /></AuthedShell>} />
          <Route path="/charts/calculators" element={<AuthedShell><Calculators /></AuthedShell>} />
          <Route path="/charts/lab-reference" element={<AuthedShell><LabReference /></AuthedShell>} />
          <Route path="/nurses-report/role-select" element={<AuthedShell><RoleSelect /></AuthedShell>} />
          <Route path="/nurses-report/analytics" element={<AuthedShell><Analytics /></AuthedShell>} />
          <Route path="/nurses-report/ward-nurse" element={<AuthedShell><WardNurse /></AuthedShell>} />
          <Route path="/nurses-report/overall-nurse" element={<AuthedShell><OverallNurse /></AuthedShell>} />
          <Route path="/nurses-report/archive-list" element={<AuthedShell><ArchiveList /></AuthedShell>} />
          <Route path="/nurses-report/archive-view" element={<AuthedShell><ArchiveView /></AuthedShell>} />
          <Route path="*" element={<AuthedShell><Home /></AuthedShell>} />
        </Routes>
        </Suspense>
      </NavProvider>
    </AuthProvider>
    </ThemeProvider>
  );
}
