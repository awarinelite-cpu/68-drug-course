import { useState } from "react";
import { acceptTransfer, rejectTransfer } from "../lib/wardTransfer.js";

// `transfers` is the list of patient objects (each carrying its own
// `pendingTransfer` field) whose pendingTransfer.toWard === this ward.
// `onResolved(patientId)` is called after a successful accept/reject so
// the caller can refresh its patient list.
export default function NewPatientTransfersModal({ ward, transfers, onClose, onResolved }) {
  const [busyId, setBusyId] = useState('');
  const [errMsg, setErrMsg] = useState('');

  async function handleAccept(p) {
    setErrMsg('');
    setBusyId(p.id);
    try {
      await acceptTransfer(p.id, p.pendingTransfer);
      onResolved(p.id);
    } catch (e) {
      setErrMsg('Could not accept ' + (p.name || 'this patient') + ': ' + (e.code || e.message));
    }
    setBusyId('');
  }

  async function handleReject(p) {
    if (!confirm('Reject ' + (p.name || 'this patient') + '? They will stay listed on ' + (p.pendingTransfer.fromWard || 'their previous ward') + '.')) return;
    setErrMsg('');
    setBusyId(p.id);
    try {
      await rejectTransfer(p.id);
      onResolved(p.id);
    } catch (e) {
      setErrMsg('Could not reject ' + (p.name || 'this patient') + ': ' + (e.code || e.message));
    }
    setBusyId('');
  }

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-box" style={{ maxWidth: 420 }}>
        <div className="modal-header">
          <h3>New Patients{ward ? ' — ' + ward : ''}</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          {transfers.length === 0 && (
            <div style={{ fontSize: 13, color: '#888', textAlign: 'center', padding: '10px 0' }}>
              No incoming patient transfers right now.
            </div>
          )}
          {transfers.map(p => (
            <div key={p.id} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 10 }}>
              <div style={{ fontWeight: 'bold' }}>{p.name || 'Unnamed'} — EMR: {p.emr || 'N/A'}</div>
              <div style={{ fontSize: 12, color: '#555', marginTop: 2 }}>
                Trans in from: {p.pendingTransfer.fromWard || 'Unknown ward'}
              </div>
              {p.diagnosis && <div style={{ fontSize: 12, color: '#555', marginTop: 2 }}>{p.diagnosis}</div>}
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button className="btn btn-success" style={{ padding: '6px 12px', fontSize: 13 }} disabled={busyId === p.id} onClick={() => handleAccept(p)}>
                  {busyId === p.id ? '…' : 'Accept'}
                </button>
                <button className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: 13 }} disabled={busyId === p.id} onClick={() => handleReject(p)}>
                  {busyId === p.id ? '…' : 'Reject'}
                </button>
              </div>
            </div>
          ))}
          {errMsg && <div className="error-msg">{errMsg}</div>}
        </div>
      </div>
    </div>
  );
}
