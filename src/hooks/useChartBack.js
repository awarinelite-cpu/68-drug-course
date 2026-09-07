import { useNavigate } from "react-router-dom";

// Every chart page's Back button (and the hardware/OS back button, wired up
// separately via useBackLock with this same target) returns to whichever
// hub page it was actually opened from:
//   - the Patient page, if opened from there (`from=patient`, only possible
//     for the active/no-admission-id case — Patient never knows about a
//     specific archived admission id)
//   - this admission's Admission Overview page, if opened from Overview
//     (`from=admission`, active or archived)
//   - Admission Overview as a safe default when that context wasn't carried
//     at all (e.g. a bookmarked/direct chart URL) — never straight to Home,
//     which would silently drop the patient the user was just looking at.
// Falls back to Home only when there's no patient in play at all.
export function chartBackTarget(patientId, admissionId, from) {
  if (!patientId) return '/';
  if (from === 'patient' && !admissionId) return '/patient?patient=' + patientId;
  return '/charts/admission?patient=' + patientId + (admissionId ? '&admission=' + admissionId : '');
}

export function useChartBack(patientId, admissionId, from) {
  const navigate = useNavigate();
  const target = chartBackTarget(patientId, admissionId, from);
  return () => navigate(target);
}
