import { useEffect, useMemo, useState } from "react";
import { db } from "../firebase.js";
import { ensureCatalogLoaded } from "../lib/nursingCatalog.js";
import { suggestDiagnoses } from "../lib/dxSuggest.js";

// "Suggested for this patient" chips shown above the Nursing Diagnosis box.
// Reads the patient's condition (diagnosis/notes, latest vitals, drug plan),
// ranks matching entries from the admin-uploaded NANDA-I catalog, and lets the
// nurse apply one with a single tap — onPick does the same auto-fill of
// Nursing Diagnosis / Planning / Implementation / Evaluation as the picker.
// Renders nothing when there is no catalog or no match, so the page is
// unchanged for wards/accounts that don't use it.
export default function NursingDiagnosisSuggestions({ patient, onPick }) {
  const [catalog, setCatalog] = useState(null);

  useEffect(() => {
    let alive = true;
    ensureCatalogLoaded(db).then((c) => { if (alive) setCatalog(c); });
    return () => { alive = false; };
  }, []);

  const key = [patient?.diagnosis, patient?.npPlan, JSON.stringify(patient?.vitalsSnapshot || null)].join('\u0001');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const suggestions = useMemo(() => suggestDiagnoses(patient, catalog, 5), [catalog, key]);

  if (!catalog || !suggestions.length) return null;
  const current = (patient?.npNursingDiagnosis || '').trim().toLowerCase();

  return (
    <div className="dx-suggest">
      <div className="dx-suggest-title">Suggested for this patient <small>(tap one to fill all four boxes)</small></div>
      <div className="dx-suggest-chips">
        {suggestions.map((s, i) => {
          const applied = current && current === String(s.dx.name).trim().toLowerCase();
          return (
            <button type="button" key={(s.dx.code || s.dx.name) + i}
              className={'dx-chip' + (i === 0 ? ' best' : '') + (applied ? ' applied' : '')}
              onClick={() => onPick(s.dx, catalog)}>
              <span>{applied ? '\u2713 ' : ''}{s.dx.name}</span>
              <small>{(i === 0 ? 'Best match \u00B7 ' : '') + s.reasons.slice(0, 2).join(', ')}</small>
            </button>
          );
        })}
      </div>
    </div>
  );
}
