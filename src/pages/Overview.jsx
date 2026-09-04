import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { doc, collection, query, orderBy } from "firebase/firestore";
import { db } from "../firebase.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import { useGoBack } from "../hooks/useGoBack.js";
import { usePatientHeader } from "../hooks/usePatientHeader.js";
import { getDocSafe, getDocsSafe } from "../lib/firestoreOffline.js";
import { buildExportRecord, downloadRecordAsPdf, downloadRecordAsJson } from "../lib/export.js";
import Topbar from "../components/Topbar.jsx";
import PatientBanner from "../components/PatientBanner.jsx";

const STATUS_LABELS = { referred: 'Referred to another hospital', transferred: 'Transferred to another ward', discharged: 'Discharged' };
const BADGE_CLASS = { referred: 'badge-referred', transferred: 'badge-transferred', discharged: 'badge-discharged' };

function formatTimestamp(ts) {
  if (!ts) return '';
  try { return ts.toDate().toLocaleString(); } catch (e) { return ''; }
}

export default function Overview() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const patientId = searchParams.get('patient');
  const goBack = useGoBack('/');
  const { patient, error: patientError } = usePatientHeader(patientId);

  const [items, setItems] = useState(null); // null = loading
  const [itemsError, setItemsError] = useState(null);
  const [exportStatus, setExportStatus] = useState('');
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!patientId) return;
    let cancelled = false;
    setItems(null);
    setItemsError(null);
    (async () => {
      const list = [];
      try {
        const [drugSnap, bgSnap, vitalsSnap, ioSnap, seizureSnap] = await Promise.all([
          getDocSafe(doc(db, 'patients', patientId, 'drugCourseChart', 'main')),
          getDocSafe(doc(db, 'patients', patientId, 'bloodGlucose', 'main')),
          getDocsSafe(collection(db, 'patients', patientId, 'vitals')),
          getDocsSafe(collection(db, 'patients', patientId, 'intakeOutput')),
          getDocsSafe(collection(db, 'patients', patientId, 'seizure'))
        ]);

        const drugData = drugSnap.exists() ? drugSnap.data() : null;
        const bgData = bgSnap.exists() ? bgSnap.data() : null;
        const hasDrugData = !!(drugData && ((drugData.f_diagnosis || '') || (drugData.drugs || []).some(d => d && d.name) || (drugData.rows || []).some(r => r && (r.date || r.sno))));
        const hasBgData = !!(bgData && (bgData.rows || []).some(r => Array.isArray(r) && r.some(cell => cell)));
        const hasActiveData = hasDrugData || hasBgData || !vitalsSnap.empty || !ioSnap.empty || !seizureSnap.empty;

        if (hasActiveData) {
          list.push({
            kind: 'active',
            diagnosis: (drugData && drugData.f_diagnosis) || 'No diagnosis entered yet',
            dateLabel: 'Currently active',
            href: '/charts/admission?patient=' + patientId
          });
        }

        try {
          const q = query(collection(db, 'patients', patientId, 'admissions'), orderBy('archivedAt', 'desc'));
          const snap = await getDocsSafe(q);
          snap.forEach(d => {
            const data = d.data();
            list.push({
              kind: data.archiveReason || 'closed',
              diagnosis: data.diagnosis || 'No diagnosis recorded',
              dateLabel: (data.archiveReasonLabel || STATUS_LABELS[data.archiveReason] || 'Closed') + ' — ' + (formatTimestamp(data.archivedAt) || data.archivedAtDisplay || ''),
              href: '/charts/admission?patient=' + patientId + '&admission=' + d.id
            });
          });
        } catch (e) {
          const snap = await getDocsSafe(collection(db, 'patients', patientId, 'admissions'));
          const archived = [];
          snap.forEach(d => archived.push({ id: d.id, ...d.data() }));
          archived.sort((a, b) => (b.archivedAtDisplay || '').localeCompare(a.archivedAtDisplay || ''));
          archived.forEach(data => {
            list.push({
              kind: data.archiveReason || 'closed',
              diagnosis: data.diagnosis || 'No diagnosis recorded',
              dateLabel: (data.archiveReasonLabel || STATUS_LABELS[data.archiveReason] || 'Closed') + ' — ' + (data.archivedAtDisplay || ''),
              href: '/charts/admission?patient=' + patientId + '&admission=' + data.id
            });
          });
        }

        if (!cancelled) setItems(list);
      } catch (e) {
        if (!cancelled) setItemsError("Couldn't load admissions: " + (e.code || e.message || 'unknown error'));
      }
    })();
    return () => { cancelled = true; };
  }, [patientId]);

  async function runFullExport(kind) {
    setExporting(true);
    setExportStatus('Gathering full admission history…');
    try {
      const record = await buildExportRecord(patientId, { scope: 'all', exportedBy: profile?.name });
      if (kind === 'pdf') {
        setExportStatus('Building PDF…');
        await downloadRecordAsPdf(record, 'full_history');
      } else {
        downloadRecordAsJson(record, 'full_history');
      }
      setExportStatus('Export complete.');
    } catch (e) {
      setExportStatus('Export failed: ' + (e.message || e.code || 'unknown error'));
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <Topbar brand="Overview">
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={goBack}>Back</button>
      </Topbar>

      <div className="container">
        <PatientBanner patient={patient} />
        {patientError && <div className="empty-msg" style={{ marginTop: 8 }}>{patientError}</div>}

        <div className="card-box" style={{ marginTop: 16 }}>
          <h3 style={{ marginTop: 0 }}>Admissions</h3>
          <div>
            {items === null && !itemsError && 'Loading…'}
            {itemsError && <div className="empty-msg">{itemsError}</div>}
            {items && items.length === 0 && <div className="empty-msg">No admissions recorded yet for this patient.</div>}
            {items && items.map((item, i) => {
              const badgeClass = item.kind === 'active' ? 'badge-active' : (BADGE_CLASS[item.kind] || 'badge-discharged');
              const badgeText = item.kind === 'active' ? 'Active' : (STATUS_LABELS[item.kind] || 'Closed');
              return (
                <div key={i} className="overview-item" onClick={() => navigate(item.href)}>
                  <div className="oi-left">
                    <span className="oi-icon">📁</span>
                    <div>
                      <div className="oi-diagnosis">{item.diagnosis}</div>
                      <div className="oi-meta">{item.dateLabel}</div>
                    </div>
                  </div>
                  <span className={"oi-badge " + badgeClass}>{badgeText}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="card-box no-print" style={{ marginTop: 16 }}>
          <h3 style={{ marginTop: 0 }}>Export Full History</h3>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" style={{ padding: '8px 14px' }} disabled={exporting} onClick={() => runFullExport('pdf')}>Export as PDF</button>
            <button className="btn btn-secondary" style={{ padding: '8px 14px' }} disabled={exporting} onClick={() => runFullExport('json')}>Export as JSON</button>
          </div>
          <div style={{ fontSize: 12, color: '#555', marginTop: 8 }}>{exportStatus}</div>
        </div>
      </div>
    </>
  );
}
