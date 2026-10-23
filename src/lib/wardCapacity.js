// Ward capacity guard: a ward can't hold more patients than it has beds.
// Bed counts are the ones set in Admin > Ward Bed Numbers (WARDS[].beds).
// Only NEW arrivals are blocked (register / admit / readmit / accept a
// transfer); patients already on a ward are never touched, so a ward that is
// already over capacity just stops taking more until someone leaves.
import { getDocs, query, collection, where } from "firebase/firestore";
import { db } from "../firebase.js";
import { WARDS, ensureWardBedsLoaded } from "./nurses-report-common.js";
import { reportWardKeysForPatientWard } from "./wardNameMatch.js";

const PED_KEY = { Bed: 'paedbed', Cot: 'paedcot' };

// Resolves to { limited, capacity, count, full, label }.
// limited=false when the ward has no matching bed count (no rule to enforce).
// Fails open (full=false) if the count can't be read, so a network hiccup
// never stops an emergency registration.
export async function getWardCapacity(wardLabel, pedBedType) {
  const none = { limited: false, capacity: 0, count: 0, full: false, label: wardLabel || '' };
  if (!wardLabel) return none;
  try {
    await ensureWardBedsLoaded(db);
    let keys = reportWardKeysForPatientWard(wardLabel);
    if (!keys.length) return none;
    const bedType = wardLabel === 'PEDIATRIC/NICU WARD' ? (pedBedType || '') : '';
    if (bedType && PED_KEY[bedType]) keys = [PED_KEY[bedType]];
    const capacity = keys.reduce((n, k) => n + ((WARDS.find((w) => w.key === k) || {}).beds || 0), 0);
    const snap = await getDocs(query(collection(db, "patients"), where("ward", "==", wardLabel)));
    let count = 0;
    snap.forEach((d) => {
      const p = d.data();
      if (p.pendingTransfer) return;
      if (bedType && (p.pedBedType || '') !== bedType) return;
      count++;
    });
    return { limited: true, capacity, count, full: count >= capacity, label: wardLabel };
  } catch (e) {
    return none;
  }
}

export function wardFullMessage(cap) {
  const ward = cap.label || 'This ward';
  return ward + ' is full (' + cap.count + '/' + cap.capacity + ' beds). A patient must be discharged or transferred out first, or an admin can raise the bed count in Ward Bed Numbers.';
}
