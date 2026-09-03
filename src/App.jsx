import { Routes, Route } from "react-router-dom";
import { AuthProvider } from "./contexts/AuthContext.jsx";
import { NavProvider } from "./contexts/NavContext.jsx";
import RequireAuth from "./components/RequireAuth.jsx";
import NavDrawer from "./components/NavDrawer.jsx";
import OfflineBanner from "./components/OfflineBanner.jsx";
import { useServiceWorker } from "./hooks/useServiceWorker.js";
import { useForegroundAlerts } from "./hooks/useForegroundAlerts.js";

import Login from "./pages/Login.jsx";
import Home from "./pages/Home.jsx";
import MyPatients from "./pages/MyPatients.jsx";
import Community from "./pages/Community.jsx";
import Profile from "./pages/Profile.jsx";
import Admin from "./pages/Admin.jsx";
import Overview from "./pages/Overview.jsx";
import Admission from "./pages/Admission.jsx";
import DrugCourseChart from "./pages/DrugCourseChart.jsx";
import Vitals from "./pages/Vitals.jsx";
import BloodGlucose from "./pages/BloodGlucose.jsx";
import IntakeOutput from "./pages/IntakeOutput.jsx";
import Seizure from "./pages/Seizure.jsx";
import Calculators from "./pages/Calculators.jsx";
import LabReference from "./pages/LabReference.jsx";
import RoleSelect from "./pages/nurses-report/RoleSelect.jsx";
import Analytics from "./pages/nurses-report/Analytics.jsx";
import WardNurse from "./pages/nurses-report/WardNurse.jsx";
import OverallNurse from "./pages/nurses-report/OverallNurse.jsx";
import ArchiveList from "./pages/nurses-report/ArchiveList.jsx";
import ArchiveView from "./pages/nurses-report/ArchiveView.jsx";

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

  return (
    <AuthProvider>
      <NavProvider>
        <OfflineBanner />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<AuthedShell><Home /></AuthedShell>} />
          <Route path="/my-patients" element={<AuthedShell><MyPatients /></AuthedShell>} />
          <Route path="/community" element={<AuthedShell><Community /></AuthedShell>} />
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
        </Routes>
      </NavProvider>
    </AuthProvider>
  );
}
