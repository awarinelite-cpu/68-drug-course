import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { collection, getDocs, doc, updateDoc } from "firebase/firestore";
import { db } from "../firebase.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import { useGoBack } from "../hooks/useGoBack.js";
import { WARDS, reportDateId, loadWardNameOverrides, loadWardBedOverrides, saveWardBeds } from "../lib/nurses-report-common.js";
import Topbar from "../components/Topbar.jsx";

export default function WardBeds() {
  const { profile } = useAuth();
  const goBack = useGoBack('/admin');
  const isAdmin = profile?.role === 'admin';

  const [loading, setLoading] = useState(true);
  const [beds, setBeds] = useState({});       // { [wardKey]: string } — what's typed in the inputs
  const [saved, setSaved] = useState({});     // { [wardKey]: number } — current stored values
  const [applyToday, setApplyToday] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null); // { text, error }

  useEffect(() => {
    (async () => {
      await Promise.all([loadWardNameOverrides(db), loadWardBedOverrides(db)]);
      const cur = {};
      WARDS.forEach(w => { cur[w.key] = w.beds; });
      setSaved(cur);
      setBeds(Object.fromEntries(WARDS.map(w => [w.key, String(w.beds)])));
      setLoading(false);
    })();
  }, []);

  function parsed(key) {
    const raw = (beds[key] ?? '').trim();
    if (raw === '' || !/^\d+$/.test(raw)) return null;
    return parseInt(raw, 10);
  }

  const changedKeys = WARDS.filter(w => parsed(w.key) !== null && parsed(w.key) !== saved[w.key]).map(w => w.key);
  const invalid = WARDS.some(w => parsed(w.key) === null);
  const totalBeds = WARDS.reduce((sum, w) => sum + (parsed(w.key) ?? 0), 0);

  async function save() {
    if (invalid) { setStatus({ text: 'Every ward needs a whole number of beds (0 or more).', error: true }); return; }
    setSaving(true);
    setStatus(null);
    try {
      const next = {};
      WARDS.forEach(w => { next[w.key] = parsed(w.key); });
      await saveWardBeds(db, next);

      let todayNote = '';
      if (applyToday && changedKeys.length) {
        // Today's live ward reports were already seeded with the old bed
        // count, so update them too (and Vac = Beds − Occ). Archived
        // reports are never touched. Wards with no report yet for today
        // simply pick up the new figure when their report is first opened.
        const dateId = reportDateId();
        const existing = await getDocs(collection(db, 'nurseReports', dateId, 'wards'));
        const byKey = {};
        existing.forEach(d => { byKey[d.id] = d.data(); });
        let updated = 0;
        for (const key of changedKeys) {
          const cur = byKey[key];
          if (!cur) continue;
          const occ = typeof cur.occ === 'number' ? cur.occ : 0;
          await updateDoc(doc(db, 'nurseReports', dateId, 'wards', key), { beds: next[key], vac: next[key] - occ });
          updated++;
        }
        todayNote = updated ? ' Today\u2019s report was updated for ' + updated + ' ward(s).' : '';
      }

      setSaved(next);
      setBeds(Object.fromEntries(WARDS.map(w => [w.key, String(next[w.key])])));
      setStatus({ text: 'Bed numbers saved.' + todayNote, error: false });
    } catch (e) {
      setStatus({ text: "Couldn't save: " + (e.code || e.message || 'unknown error'), error: true });
    }
    setSaving(false);
  }

  function resetToDefaults() {
    setBeds(Object.fromEntries(WARDS.map(w => [w.key, String(w.defaultBeds)])));
    setStatus(null);
  }

  if (!profile) return null;
  if (!isAdmin) return <Navigate to="/" replace />;

  return (
    <>
      <Topbar brand="68 NARHY Ward Charts — Ward Bed Numbers">
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={goBack}>Back</button>
      </Topbar>

      <div className="container">
        <div className="card-box">
          <h3 style={{ marginTop: 0 }}>Ward Bed Numbers</h3>
          <p style={{ fontSize: 12, color: '#666', marginTop: -6 }}>
            The Beds column in the ward statistics tables (Ward Nurse, Overall Nurse, Analytics) starts from these
            numbers each day. Nurses can still adjust a single day's figure on their own report; changing it here
            sets the standing default. Vacant beds are worked out as Beds minus Occupied. Archived reports keep
            the figures they were saved with.
          </p>

          <div className="table-wrap">
            <table className="entries">
              <thead><tr><th>Ward</th><th>Beds</th><th>Built-in default</th></tr></thead>
              <tbody>
                {loading && <tr><td colSpan={3} style={{ color: '#666' }}>Loading…</td></tr>}
                {!loading && WARDS.map((w) => {
                  const bad = parsed(w.key) === null;
                  const changed = !bad && parsed(w.key) !== saved[w.key];
                  return (
                    <tr key={w.key}>
                      <td style={{ textAlign: 'left' }}>{w.label}</td>
                      <td>
                        <input type="number" inputMode="numeric" min="0" step="1" style={{ width: 80, borderColor: bad ? '#dc2626' : undefined, background: changed ? '#fef9c3' : undefined }}
                          value={beds[w.key] ?? ''} disabled={saving}
                          onChange={(e) => setBeds((m) => ({ ...m, [w.key]: e.target.value }))} />
                      </td>
                      <td style={{ color: '#666' }}>{w.defaultBeds}</td>
                    </tr>
                  );
                })}
              </tbody>
              {!loading && (
                <tfoot><tr><td style={{ textAlign: 'left', fontWeight: 'bold' }}>Total</td><td style={{ fontWeight: 'bold' }}>{totalBeds}</td><td></td></tr></tfoot>
              )}
            </table>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 'normal', fontSize: 13, marginTop: 12 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={applyToday} onChange={(e) => setApplyToday(e.target.checked)} />
            Also update today&rsquo;s open ward reports
          </label>

          <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" disabled={saving || loading || invalid || !changedKeys.length} onClick={save}>
              {saving ? 'Saving…' : 'Save Bed Numbers' + (changedKeys.length ? ' (' + changedKeys.length + ')' : '')}
            </button>
            <button className="btn btn-secondary" disabled={saving || loading} onClick={resetToDefaults}>Reset to built-in defaults</button>
          </div>
          {status && <div className={status.error ? 'error-msg' : 'info-msg'}>{status.text}</div>}
        </div>
      </div>
    </>
  );
}
