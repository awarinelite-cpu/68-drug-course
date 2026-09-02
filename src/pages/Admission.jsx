import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { doc, getDoc, setDoc, deleteDoc, addDoc, collection, getDocs, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import { useGoBack } from "../hooks/useGoBack.js";
import { usePatientHeader } from "../hooks/usePatientHeader.js";
import { buildExportRecord, downloadRecordAsPdf, downloadRecordAsJson, sharePdf } from "../lib/export.js";
import Topbar from "../components/Topbar.jsx";
import PatientBanner from "../components/PatientBanner.jsx";

const STATUS_LABELS = { referred: 'Referred to another hospital', transferred: 'Transferred to another ward', discharged: 'Discharged' };
const BADGE_CLASS = { referred: 'badge-referred', transferred: 'badge-transferred', discharged: 'badge-discharged' };

const CHARTS = [
  { key: 'drug-course-chart', label: 'Drug Course Chart', icon: '💊' },
  { key: 'vitals', label: 'Vital Signs', icon: '❤️' },
  { key: 'blood-glucose', label: 'Glycemic Chart', icon: '🩸' },
  { key: 'intake-output', label: 'Intake & Output', icon: '💧' },
  { key: 'seizure', label: 'Seizure Chart', icon: '⚡' }
];

export default function Admission() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const patientId = searchParams.get('patient');
  const admissionId = searchParams.get('admission');
  const isArchived = !!admissionId;
  const goBack = useGoBack(patientId ? '/charts/overview?patient=' + patientId : '/');
  const { patient } = usePatientHeader(patientId);

  const [info, setInfo] = useState(null); // { diagnosis, metaLabel, badgeText, badgeClass }
  const [notFound, setNotFound] = useState(false);
  const [archiveReason, setArchiveReason] = useState(null);
  const archivedAdmissionDataRef = useRef(null);
  const [readmitBusy, setReadmitBusy] = useState(false);
  const [readmitStatus, setReadmitStatus] = useState({ color: '', text: '' });

  const [shareBusy, setShareBusy] = useState(false);
  const [shareStatus, setShareStatus] = useState({ color: '#b91c1c', text: '' });

  const [exportBusy, setExportBusy] = useState(false);
  const [exportStatus, setExportStatus] = useState('');

  useEffect(() => {
    if (!patientId) return;
    (async () => {
      if (isArchived) {
        const snap = await getDoc(doc(db, 'patients', patientId, 'admissions', admissionId));
        if (!snap.exists()) { setNotFound(true); return; }
        const data = snap.data();
        archivedAdmissionDataRef.current = data;
        setArchiveReason(data.archiveReason || null);
        setInfo({
          diagnosis: data.diagnosis || 'No diagnosis recorded',
          metaLabel: data.archivedAtDisplay ? 'Closed on ' + data.archivedAtDisplay : '',
          badgeText: data.archiveReasonLabel || STATUS_LABELS[data.archiveReason] || 'Closed',
          badgeClass: BADGE_CLASS[data.archiveReason] || 'badge-discharged'
        });
      } else {
        const drugSnap = await getDoc(doc(db, 'patients', patientId, 'drugCourseChart', 'main'));
        setInfo({
          diagnosis: (drugSnap.exists() && drugSnap.data().f_diagnosis) || 'No diagnosis entered yet',
          metaLabel: 'Currently active',
          badgeText: 'Active',
          badgeClass: 'badge-active'
        });
      }
    })();
  }, [patientId, admissionId, isArchived]);

  useEffect(() => {
    if (notFound && patientId) navigate('/charts/overview?patient=' + patientId);
  }, [notFound, patientId, navigate]);

  // Mirrors Overview's own hasActiveData check — used to make sure
  // readmitting doesn't silently overwrite a newer admission that's already
  // in progress on the live charts.
  async function hasActiveData() {
    const [drugSnap, bgSnap, vitalsSnap, ioSnap, seizureSnap] = await Promise.all([
      getDoc(doc(db, 'patients', patientId, 'drugCourseChart', 'main')),
      getDoc(doc(db, 'patients', patientId, 'bloodGlucose', 'main')),
      getDocs(collection(db, 'patients', patientId, 'vitals')),
      getDocs(collection(db, 'patients', patientId, 'intakeOutput')),
      getDocs(collection(db, 'patients', patientId, 'seizure'))
    ]);
    const drugData = drugSnap.exists() ? drugSnap.data() : null;
    const bgData = bgSnap.exists() ? bgSnap.data() : null;
    const hasDrugData = !!(drugData && ((drugData.f_diagnosis || '') || (drugData.drugs || []).some(d => d && d.name) || (drugData.rows || []).some(r => r && (r.date || r.sno))));
    const hasCells = arr => (arr || []).some(r => (r.cells || r || []).some(cell => cell));
    const hasBgData = !!(bgData && (hasCells(bgData.rows6) || hasCells(bgData.rows3) || hasCells(bgData.rows)));
    return hasDrugData || hasBgData || !vitalsSnap.empty || !ioSnap.empty || !seizureSnap.empty;
  }

  async function readmitPatient() {
    const patientName = (patient?.name || '').trim() || 'this patient';
    if (!confirm('Readmit ' + patientName + '?\n\nThis cancels the discharge and restores the drug chart, vitals, glycemic chart, intake & output, and seizure chart from this admission back to active. Care continues from exactly where it left off.')) return;

    setReadmitBusy(true);
    setReadmitStatus({ color: '#555', text: 'Checking for a newer admission already in progress\u2026' });

    try {
      if (await hasActiveData()) {
        setReadmitStatus({ color: '#b91c1c', text: 'This patient already has an active admission in progress — readmitting this record would overwrite it. Close out or resolve the current admission first, or contact an admin.' });
        setReadmitBusy(false);
        return;
      }

      setReadmitStatus({ color: '#555', text: 'Restoring charts\u2026' });
      const admData = archivedAdmissionDataRef.current || {};
      const dc = admData.drugCourseChart || {};
      const restoredAuditLog = Array.isArray(dc.auditLog) ? dc.auditLog.slice() : [];
      restoredAuditLog.push({
        text: 'Patient readmitted — discharge on ' + (admData.archivedAtDisplay || 'an earlier date') + ' cancelled; care continues.',
        nurse: profile?.name || 'Unknown',
        at: new Date().toISOString()
      });
      const restoredDrugChart = {
        ...dc,
        f_discharge: '', // no longer discharged
        auditLog: restoredAuditLog,
        updatedAt: serverTimestamp()
      };
      const bg = admData.bloodGlucose || { chartType: '6point', rows6: [], rows3: [] };
      const ioSummary = admData.intakeOutputSummary || { intake: 0, output: 0, balance: 0, periodDate: new Date().toISOString().slice(0, 10) };

      await Promise.all([
        setDoc(doc(db, 'patients', patientId, 'drugCourseChart', 'main'), restoredDrugChart),
        setDoc(doc(db, 'patients', patientId, 'bloodGlucose', 'main'), {
          chartType: bg.chartType || '6point',
          // A record archived before per-type storage existed may still only
          // have the old single 'rows' field — carry it into whichever type
          // it belonged to instead of dropping it.
          rows6: bg.rows6 || (bg.chartType !== '3point' ? (bg.rows || []) : []),
          rows3: bg.rows3 || (bg.chartType === '3point' ? (bg.rows || []) : []),
          updatedAt: serverTimestamp()
        }),
        setDoc(doc(db, 'patients', patientId, 'intakeOutputSummary', 'current'), { ...ioSummary, updatedAt: serverTimestamp() }),
        ...(admData.vitals || []).map(entry => addDoc(collection(db, 'patients', patientId, 'vitals'), entry)),
        ...(admData.intakeOutput || []).map(entry => addDoc(collection(db, 'patients', patientId, 'intakeOutput'), entry)),
        ...(admData.seizure || []).map(entry => addDoc(collection(db, 'patients', patientId, 'seizure'), entry))
      ]);

      // The discharge is cancelled, not just superseded — remove the
      // archived record so it doesn't keep showing as a closed admission
      // alongside the now-active one it was restored into.
      await deleteDoc(doc(db, 'patients', patientId, 'admissions', admissionId));

      setReadmitStatus({ color: '#16a34a', text: 'Readmitted \u2014 redirecting to the active chart\u2026' });
      setTimeout(() => navigate('/charts/drug-course-chart?patient=' + patientId), 900);
    } catch (e) {
      setReadmitStatus({ color: '#b91c1c', text: 'Readmit failed: ' + (e.code || e.message || 'unknown error') });
      setReadmitBusy(false);
    }
  }

  function chartHref(key) {
    return '/charts/' + key + '?patient=' + patientId + (isArchived ? '&admission=' + admissionId : '');
  }

  async function shareAdmission() {
    setShareBusy(true);
    setShareStatus({ color: '#555', text: '' });
    try {
      const record = await buildExportRecord(patientId, { admissionId: isArchived ? admissionId : null });
      const diagnosis = (info?.diagnosis || '').trim();
      const patientName = (patient?.name || '').trim();
      const result = await sharePdf(record, isArchived ? 'admission' : 'active_admission', diagnosis + ' — ' + patientName);
      if (result.downloaded) {
        setShareStatus({ color: '#555', text: 'Your browser can\u2019t share files directly, so the PDF was downloaded instead \u2014 you can share it from there.' });
      } else {
        setShareStatus({ color: '#555', text: '' });
      }
    } catch (e) {
      setShareStatus({ color: '#b91c1c', text: 'Could not prepare the PDF to share: ' + (e.message || e.code || 'unknown error') });
    } finally {
      setShareBusy(false);
    }
  }

  async function runExport(kind) {
    setExportBusy(true);
    setExportStatus('Gathering this admission\u2019s record\u2026');
    try {
      const record = await buildExportRecord(patientId, { admissionId: isArchived ? admissionId : null, exportedBy: profile?.name });
      if (kind === 'pdf') {
        setExportStatus('Building PDF\u2026');
        await downloadRecordAsPdf(record, isArchived ? 'admission' : 'active_admission');
      } else {
        downloadRecordAsJson(record, isArchived ? 'admission' : 'active_admission');
      }
      setExportStatus('Export complete.');
    } catch (e) {
      setExportStatus('Export failed: ' + (e.message || e.code || 'unknown error'));
    } finally {
      setExportBusy(false);
    }
  }

  return (
    <>
      <Topbar brand="Admission Overview">
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={goBack}>Back</button>
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} disabled={shareBusy} onClick={shareAdmission}>
          {shareBusy ? 'Preparing…' : 'Share'}
        </button>
        <button className="btn btn-primary" style={{ padding: '6px 12px' }} onClick={() => window.print()}>Print</button>
      </Topbar>
      {shareStatus.text && (
        <div className="no-print" style={{ fontSize: 12, color: shareStatus.color, padding: '4px 16px 0' }}>{shareStatus.text}</div>
      )}

      <div className="container">
        <PatientBanner patient={patient} />

        <div className="card-box" style={{ marginTop: 16 }}>
          <div className="pname" style={{ fontSize: 17 }}>
            {info?.diagnosis || '—'}
            {info && <span className={"badge " + info.badgeClass}>{info.badgeText}</span>}
          </div>
          {isArchived && archiveReason === 'discharged' && (
            <button className="badge no-print" style={{ border: 'none', cursor: 'pointer', background: '#2563eb', marginTop: 6, padding: '4px 10px' }}
              disabled={readmitBusy} onClick={readmitPatient}>
              {readmitBusy ? 'Working…' : '\u21BA Readmit'}
            </button>
          )}
          <div className="pmeta" style={{ marginTop: 4 }}>{info?.metaLabel || ''}</div>
          {readmitStatus.text && <div className="no-print" style={{ fontSize: 12, marginTop: 6, color: readmitStatus.color }}>{readmitStatus.text}</div>}
        </div>

        <div className="chart-grid">
          {CHARTS.map(c => (
            <div key={c.key} className="chart-card" onClick={() => navigate(chartHref(c.key))}>
              <span className="icon">{c.icon}</span>{c.label}
            </div>
          ))}
        </div>

        <div className="card-box no-print" style={{ marginTop: 16 }}>
          <h3 style={{ marginTop: 0 }}>Export This Admission</h3>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" style={{ padding: '8px 14px' }} disabled={exportBusy} onClick={() => runExport('pdf')}>Export as PDF</button>
            <button className="btn btn-secondary" style={{ padding: '8px 14px' }} disabled={exportBusy} onClick={() => runExport('json')}>Export as JSON</button>
          </div>
          <div style={{ fontSize: 12, color: '#555', marginTop: 8 }}>{exportStatus}</div>
        </div>
      </div>
    </>
  );
}
