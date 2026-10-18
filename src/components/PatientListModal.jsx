import { createContext, useCallback, useContext, useMemo, useState } from "react";
import {
  statPatients, demoPatients, LISTABLE_STAT_KEYS, LISTABLE_DEMO_CATEGORIES
} from "../lib/movementPatients.js";

const PopupCtx = createContext(null);

function PatientListModal({ state, onClose }) {
  const { title, total, loading, error, patients } = state;
  return (
    <div className="pl-backdrop" onClick={onClose} role="presentation">
      <div className="pl-modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="pl-head">
          <div className="pl-title">{title}</div>
          <button type="button" className="pl-close" onClick={onClose} aria-label="Close">{"\u2715"}</button>
        </div>
        <div className="pl-body">
          {loading && <div className="pl-note">Loading…</div>}
          {!loading && error && <div className="pl-note">Could not load the patient list.</div>}
          {!loading && !error && patients.length === 0 && <div className="pl-note">No patient names found for this number.</div>}
          {!loading && !error && patients.length > 0 && (
            <>
              <table className="pl-table">
                <thead><tr><th>#</th><th>Name</th><th>EMR No.</th></tr></thead>
                <tbody>
                  {patients.map((p, i) => (
                    <tr key={i}><td>{i + 1}</td><td className="pl-name">{p.name}</td><td>{p.emr || "\u2014"}</td></tr>
                  ))}
                </tbody>
              </table>
              {patients.length !== total && (
                <div className="pl-note">
                  Showing {patients.length} of {total}. The other {Math.max(0, total - patients.length)} {total - patients.length === 1 ? "is" : "are"} not on this ward's patient list.
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Wrap a page once; every <PNum> inside opens the same pop-up.
export function PatientPopupProvider({ children }) {
  const [state, setState] = useState(null);
  const open = useCallback(async (title, total, resolve) => {
    setState({ title, total, loading: true, error: false, patients: [] });
    try {
      const patients = await resolve();
      setState((s) => (s ? { ...s, loading: false, patients } : s));
    } catch (e) {
      setState((s) => (s ? { ...s, loading: false, error: true } : s));
    }
  }, []);
  const value = useMemo(() => ({ open }), [open]);
  return (
    <PopupCtx.Provider value={value}>
      {children}
      {state && <PatientListModal state={state} onClose={() => setState(null)} />}
    </PopupCtx.Provider>
  );
}

// A number in a statistics / demographics table. Tap it and the patients who
// make up the number pop up (names + EMR numbers). Anything that has no
// patient list behind it (Beds, Vac, S/C, BID ...) or is zero stays plain text.
//   kind  'stat' | 'demo'
//   keys  report-ward keys the cell covers (one ward, a merged group, or all)
//   field STAT_FIELDS key (stat) or demographics field key like 'adm_milM' (demo)
//   docs  { wardKey: wardDoc } holding each ward's patient list
//   label what to call the cell in the pop-up title
export function PNum({ n, kind, keys, field, docs, label }) {
  const ctx = useContext(PopupCtx);
  const value = typeof n === "number" ? n : (parseFloat(n) || 0);
  const listable = kind === "stat"
    ? LISTABLE_STAT_KEYS.has(field)
    : LISTABLE_DEMO_CATEGORIES.has(String(field).split("_")[0]);
  if (!ctx || !listable || value <= 0) return <>{n}</>;
  const go = () => ctx.open(label + " \u2014 " + value, value, () => (
    kind === "stat" ? Promise.resolve(statPatients(docs, keys, field)) : demoPatients(docs, keys, field)
  ));
  return (
    <button type="button" className="num-tap" onClick={go} title="Tap to see the patients">{n}</button>
  );
}
