import { useState } from "react";
import { useAuth } from "../contexts/AuthContext.jsx";
import { applyPatientStatus, admitExistingPatientToWard, setPatientParoleStatus, markPatientNotAdmitted, markPatientOldPatient } from "../lib/patientAdmissionStatus.js";
import { PAROLE_PATIENT_WARD_LABEL, todayISO } from "../lib/nurses-report-common.js";
import { STATUS_LABELS, WARD_OPTIONS } from "../lib/drugChartHelpers.js";

// Status button for a patient card on the ward list. Same actions and
// rules as the Status control on the Patient page, but opens as a popup
// so a nurse can discharge / transfer / etc. without opening the patient.
// onApplied() fires after a successful change so the list can refresh.
export default function PatientStatusButton({ patient, onApplied }) {
  const { profile } = useAuth();
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState('');
  const [transferWard, setTransferWard] = useState('');
  const [paroleStart, setParoleStart] = useState(todayISO());
  const [paroleReturn, setParoleReturn] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ color: '', text: '' });

  const err = (text) => setMsg({ color: '#dc2626', text });
  const stop = (e) => e.stopPropagation();

  function close() {
    setOpen(false); setAction(''); setTransferWard(''); setMsg({ color: '', text: '' });
  }
  function done(text) {
    setMsg({ color: '#16a34a', text });
    setBusy(false);
    setTimeout(() => { close(); onApplied && onApplied(); }, 700);
  }

  async function apply() {
    const reason = action;
    if (!reason) return err('Please select an action first.');
    if (reason === 'transferred' && !transferWard) return err('Please select which ward the patient is being transferred to.');

    if (reason === 'parole' || reason === 'dparole' || reason === 'paroleClear') {
      if (reason !== 'paroleClear' && patient.ward !== PAROLE_PATIENT_WARD_LABEL) return err('Parole is only tracked for A Ward patients.');
      const kind = reason === 'paroleClear' ? 'clear' : reason;
      if (kind !== 'clear' && paroleReturn && paroleStart && paroleReturn < paroleStart) return err('Return date can\u2019t be before the commencement date.');
      setBusy(true); setMsg({ color: '#555', text: 'Saving…' });
      const r = await setPatientParoleStatus({ patientId: patient.id, kind, startDate: paroleStart, returnDate: paroleReturn });
      if (!r.ok) { setBusy(false); return err(r.message); }
      return done(r.value ? 'Patient placed on ' + (r.value === 'PAROLE' ? 'Parole' : 'D/Parole') + '.' : 'Parole tag cleared.');
    }

    if (reason === 'admitted') {
      if (!navigator.onLine) return err('This needs an internet connection. Please try again once online.');
      const destWard = profile?.ward || '';
      if (!confirm('Admit ' + (patient.name || 'this patient') + ' to ' + (destWard || 'your ward') + '?')) return;
      setBusy(true); setMsg({ color: '#555', text: 'Admitting…' });
      const r = await admitExistingPatientToWard({ patientId: patient.id, currentWard: patient.ward, nurseWard: destWard, pedBedType: patient.pedBedType });
      if (!r.ok) { setBusy(false); return err(r.message); }
      return done('Admitted to ' + (destWard || 'your ward') + '.');
    }

    if (reason === 'oldPatient') {
      if (!confirm('Confirm: Old patient?\n\nThis patient was already on the ward and is not a new patient. The NEW PATIENT tag will be removed. Nothing else changes.')) return;
      setBusy(true); setMsg({ color: '#555', text: 'Updating…' });
      const r = await markPatientOldPatient({ patientId: patient.id });
      if (!r.ok) { setBusy(false); return err(r.message); }
      return done('Marked as old patient.');
    }

    if (reason === 'notAdmitted') {
      if (!navigator.onLine) return err('This needs an internet connection. Please try again once online.');
      if (!confirm('Confirm: Not admitted?\n\nThis patient was never truly admitted. The ADM count will be reversed and the patient file will move to the Archive. Nothing is deleted \u2014 all charts are kept in Overview.')) return;
      setBusy(true); setMsg({ color: '#555', text: 'Moving patient to Archive…' });
      const r = await markPatientNotAdmitted({ patientId: patient.id });
      if (!r.ok) { setBusy(false); return err(r.message); }
      return done('Moved to Archive.');
    }

    if (reason !== 'transferred' && !navigator.onLine) return err('This needs an internet connection \u2014 it archives records from several charts. Please try again once online.');
    const label = reason === 'transferred' ? ('Transferred to ' + transferWard) : STATUS_LABELS[reason];
    const body = reason === 'transferred'
      ? 'The patient moves to ' + transferWard + '\u2019s New Patient queue \u2014 a nurse there still has to accept them. All charts stay as they are.'
      : 'All care records for this admission (drug chart, vitals, glycemic chart, intake & output, seizure chart) will be saved together to Overview, and fresh charts will open for this patient.';
    if (!confirm('Confirm: ' + label + ' \u2014 ' + (patient.name || 'patient') + '?\n\n' + body)) return;
    setBusy(true); setMsg({ color: '#555', text: reason === 'transferred' ? 'Sending transfer…' : 'Saving all charts for this admission…' });
    const r = await applyPatientStatus({ patientId: patient.id, reason, transferWard, fromWard: patient.ward, transferredByName: profile?.name });
    if (!r.ok) { setBusy(false); return err(r.message); }
    done(reason === 'transferred' ? 'Sent to ' + transferWard + ' \u2014 awaiting acceptance.' : 'Saved to Overview.');
  }

  return (
    <span className="patient-status-wrap" onClick={stop}>
      <button type="button" className="btn btn-secondary patient-status-btn" onClick={(e) => { stop(e); setOpen(true); }}>Status</button>
      {open && (
        <div className="patient-status-overlay" onClick={(e) => { stop(e); if (!busy) close(); }}>
          <div className="card-box patient-status-modal" onClick={stop}>
            <div style={{ fontWeight: 'bold', marginBottom: 2 }}>{patient.name || 'Patient'}</div>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 10 }}>EMR: {patient.emr || 'N/A'}</div>
            <label style={{ fontWeight: 'bold', fontSize: 13, display: 'block', marginBottom: 6 }}>Patient Status</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <select value={action} onChange={(e) => setAction(e.target.value)}>
                <option value="">Select action…</option>
                {['admitted', 'notAdmitted', 'oldPatient', 'discharged', 'transferred', 'referred', 'died', 'dama', 'absconded', 'parole', 'dparole'].map((k) => (
                  <option key={k} value={k}>{STATUS_LABELS[k]}</option>
                ))}
                {patient.paroleStatus && <option value="paroleClear">{STATUS_LABELS.paroleClear}</option>}
              </select>
              {action === 'transferred' && (
                <select value={transferWard} onChange={(e) => setTransferWard(e.target.value)}>
                  <option value="">Select ward…</option>
                  {WARD_OPTIONS.map((w) => <option key={w} value={w}>{w}</option>)}
                </select>
              )}
              {(action === 'parole' || action === 'dparole') && (
                <>
                  <label style={{ fontSize: 12 }}>Commencement date
                    <input type="date" value={paroleStart} onChange={(e) => setParoleStart(e.target.value)} />
                  </label>
                  <label style={{ fontSize: 12 }}>Return date
                    <input type="date" value={paroleReturn} min={paroleStart || undefined} onChange={(e) => setParoleReturn(e.target.value)} />
                  </label>
                </>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={apply}>Apply</button>
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={close}>Cancel</button>
              </div>
              {msg.text && <div style={{ fontSize: 12, color: msg.color }}>{msg.text}</div>}
            </div>
          </div>
        </div>
      )}
    </span>
  );
}
