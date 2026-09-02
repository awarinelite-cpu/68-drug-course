import { useNavigate } from "react-router-dom";

// Every chart page's Back button always returns to this admission's
// Admission Overview page (not wherever browser history happens to point —
// e.g. straight back to the ward list when the chart was opened directly
// from Home rather than via Overview), or Home if there's no patient at all.
export function useChartBack(patientId, admissionId) {
  const navigate = useNavigate();
  const target = patientId
    ? '/charts/admission?patient=' + patientId + (admissionId ? '&admission=' + admissionId : '')
    : '/';
  return () => navigate(target);
}
