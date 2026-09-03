import { useState } from "react";

// Normalizes a Nigerian-style local number ("080...", "070...") or an
// already-international one ("+234...", "234...") down to bare digits
// with the country code, suitable for tel:/wa.me links. Falls back to
// just stripping non-digits if it doesn't look like a Nigerian number.
export function normalizePhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/[^\d]/g, '');
  if (!digits) return '';
  if (digits.startsWith('234')) return digits;
  if (digits.startsWith('0')) return '234' + digits.slice(1);
  return digits;
}

// Shows a submitting nurse's full name and phone number, with a
// call-or-WhatsApp chooser once the phone number itself is tapped.
// `nurse` is { name, phone, wardLabel } — phone may be missing if the
// nurse hasn't filled it in on her Profile page yet.
export default function ReportContactModal({ nurse, onClose }) {
  const [showChooser, setShowChooser] = useState(false);
  if (!nurse) return null;

  const digits = normalizePhone(nurse.phone);

  return (
    <div className="modal-overlay no-print" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-box" style={{ maxWidth: 340 }}>
        <div className="modal-header">
          <h3>{nurse.wardLabel ? nurse.wardLabel + ' — Nurse on Duty' : 'Nurse on Duty'}</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <div className="patient-line"><h3>Full Name: </h3>{nurse.name || 'Unknown'}</div>

          {!digits && (
            <div className="patient-line"><h3>Phone Number: </h3>Not on file</div>
          )}

          {digits && !showChooser && (
            <div className="patient-line">
              <h3>Phone Number: </h3>
              <button type="button" className="contact-phone-btn" onClick={() => setShowChooser(true)}>
                {nurse.phone}
              </button>
            </div>
          )}

          {digits && showChooser && (
            <div className="contact-choice">
              <div style={{ fontSize: 13, color: '#555', marginBottom: 2 }}>Reach {nurse.name || 'this nurse'} via:</div>
              <a className="btn btn-primary contact-choice-btn" href={'tel:+' + digits}>
                {'\uD83D\uDCDE Call'}
              </a>
              <a className="btn btn-secondary contact-choice-btn" href={'https://wa.me/' + digits} target="_blank" rel="noreferrer">
                {'\uD83D\uDCAC WhatsApp'}
              </a>
              <button type="button" className="btn btn-secondary contact-choice-btn" onClick={() => setShowChooser(false)}>
                Back
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
