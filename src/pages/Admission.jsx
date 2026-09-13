import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { doc, getDoc } from "firebase/firestore";
import { db } from "../firebase.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import { readmitLatestAdmission, READMIT_ELIGIBLE_REASONS } from "../lib/patientAdmissionStatus.js";
import { useGoBack } from "../hooks/useGoBack.js";
import { useBackLock } from "../hooks/useBackLock.js";
import { usePatientHeader } from "../hooks/usePatientHeader.js";
import { buildExportRecord, downloadRecordAsPdf, downloadRecordAsJson, sharePdf } from "../lib/export.js";
import Topbar from "../components/Topbar.jsx";
import PatientBanner from "../components/PatientBanner.jsx";

const STATUS_LABELS = { referred: 'Referred to another hospital', transferred: 'Transferred to another ward', discharged: 'Discharged', died: 'Death' };
const BADGE_CLASS = { referred: 'badge-referred', transferred: 'badge-transferred', discharged: 'badge-discharged', died: 'badge-died' };

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
  const backTarget = patientId ? '/charts/overview?patient=' + patientId : '/';
  const goBack = useGoBack(backTarget);
  useBackLock(backTarget);
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

  async function readmitPatient() {
    const patientName = (patient?.name || '').trim() || 'this patient';
    if (!confirm('Readmit ' + patientName + '?\n\nThis cancels the exit and restores the drug chart, vitals, glycemic chart, intake & output, and seizure chart from this admission back to active. Care continues from exactly where it left off.')) return;

    // Same reasoning as applyStatusAction's guard on the drug chart page:
    // this restores multiple collections from the archived record and then
    // deletes the archive doc, all in a specific order that depends on each
    // step actually completing — not something to risk running against a
    // stale offline cache.
    if (!navigator.onLine) {
      setReadmitStatus({ color: '#b91c1c', text: "This needs an internet connection — readmitting restores several charts from the archived record and then removes it, and doing that safely requires reading the real data. Please try again once online." });
      return;
    }

    setReadmitBusy(true);
    setReadmitStatus({ color: '#555', text: 'Restoring charts\u2026' });

    const result = await readmitLatestAdmission({ patientId, nurseName: profile?.name });
    if (!result.ok) {
      setReadmitStatus({ color: '#b91c1c', text: result.message });
      setReadmitBusy(false);
      return;
    }

    setReadmitStatus({ color: '#16a34a', text: 'Readmitted \u2014 redirecting to the active chart\u2026' });
    setTimeout(() => navigate('/charts/drug-course-chart?patient=' + patientId + '&from=admission'), 900);
  }

  function chartHref(key) {
    return '/charts/' + key + '?patient=' + patientId + (isArchived ? '&admission=' + admissionId : '') + '&from=admission';
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
          {isArchived && READMIT_ELIGIBLE_REASONS.includes(archiveReason) && (
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
