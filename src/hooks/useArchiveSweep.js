// The automatic archive sweep used to run in a Cloud Function
// (sweepClosedReports). The app now runs on the free Firebase plan with no
// Cloud Functions, so this is a deliberate no-op. Ward reports are archived
// manually ("Move to Archive" / the Overall Nurse's "Save to Archive").
// Kept as a hook so the call sites in WardNurse/OverallNurse stay unchanged.
export default function useArchiveSweep() {}
