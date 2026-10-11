// Suggests NANDA-I diagnoses from a patient's condition (diagnosis/notes text,
// latest vitals, current drug plan). Pure rule-based keyword matching — no
// network, works offline. It ONLY ranks entries that already exist in the
// admin-uploaded catalog (rule targets are matched against catalog names), and
// it never writes anything: the nurse taps a suggestion and the existing
// applyNursingDiagnosis() does the filling.

// re: condition keywords. targets: phrases looked up inside catalog diagnosis
// names (lowercase substring), strongest first. w: rule weight.
const RULES = [
  { label: 'fever / infection', re: /\b(malaria|fever|febrile|pyrexia|typhoid|sepsis|septic|septicaemia|septicemia|meningitis|infection|abscess)\b/i,
    targets: ['hyperthermia', 'risk for infection', 'infection', 'deficient fluid volume', 'ineffective thermoregulation'], w: 3 },
  { label: 'respiratory', re: /\b(\w*pneumonia|asthma|copd|bronchiolitis|bronchitis|cough|dyspn[o]?ea|tuberculosis|tb|pleural|respiratory|breathless|wheez\w*|pulmonary|chest infection|ards|oedema of the lung)\b/i,
    targets: ['ineffective airway clearance', 'impaired gas exchange', 'ineffective breathing pattern', 'activity intolerance'], w: 3 },
  { label: 'fluid loss / GI', re: /\b(diarrh[o]?ea|gastroenteritis|vomiting|dehydrat\w*|cholera|gastro-?enteritis|hyperemesis)\b/i,
    targets: ['deficient fluid volume', 'diarrhea', 'nausea', 'imbalanced nutrition', 'risk for electrolyte imbalance'], w: 3 },
  { label: 'hypertension / pre-eclampsia', re: /\b(hypertensi\w*|htn|pre-?eclampsia|eclampsia|hypertensive)\b/i,
    targets: ['risk for decreased cardiac tissue perfusion', 'ineffective peripheral tissue perfusion', 'decreased cardiac output', 'risk for injury', 'deficient knowledge', 'risk for ineffective cerebral tissue perfusion'], w: 2.5 },
  { label: 'cardiac', re: /\b(heart failure|ccf|chf|cardiac|cardiomyopathy|myocardial|angina|arrhythmia|mi)\b/i,
    targets: ['decreased cardiac output', 'excess fluid volume', 'activity intolerance', 'ineffective peripheral tissue perfusion', 'fatigue'], w: 3 },
  { label: 'diabetes / glucose', re: /\b(diabet\w*|dm|dka|hyperglyc[a]?emi\w*|hypoglyc[a]?emi\w*|blood sugar)\b/i,
    targets: ['unstable blood glucose', 'risk for unstable blood glucose', 'deficient fluid volume', 'risk for infection', 'deficient knowledge'], w: 3 },
  { label: 'neurological', re: /\b(stroke|cva|hemipleg\w*|paralysis|head injury|brain|tia|cerebral)\b/i,
    targets: ['impaired physical mobility', 'impaired verbal communication', 'risk for falls', 'self-care deficit', 'risk for aspiration', 'ineffective cerebral tissue perfusion'], w: 3 },
  { label: 'seizure', re: /\b(seizure\w*|epilep\w*|convuls\w*|fit|fits|status epilepticus)\b/i,
    targets: ['risk for injury', 'ineffective airway clearance', 'risk for aspiration', 'risk for falls'], w: 3 },
  { label: 'unconscious', re: /\b(unconscious\w*|coma|comatose|gcs|altered sensorium|reduced consciousness|drowsy)\b/i,
    targets: ['ineffective airway clearance', 'risk for aspiration', 'impaired physical mobility', 'risk for pressure', 'impaired swallowing', 'self-care deficit'], w: 3 },
  { label: 'surgery / wound / trauma', re: /\b(post-?op\w*|surgery|laparotomy|appendectomy|herniorrhaphy|caesarean|cesarean|c\/s|wound|burn\w*|ulcer|fracture\w*|rta|trauma\w*|gunshot|gsw|laceration|amputation|incision|cellulitis)\b/i,
    targets: ['acute pain', 'impaired skin integrity', 'impaired tissue integrity', 'risk for infection', 'impaired physical mobility', 'risk for bleeding'], w: 3 },
  { label: 'pain', re: /\b(pain\w*|colic|headache|migraine|ache|dysmenorrh[o]?ea|arthritis|sickle cell crisis|crisis)\b/i,
    targets: ['acute pain', 'chronic pain', 'impaired comfort'], w: 2.5 },
  { label: 'renal', re: /\b(renal|kidney|ckd|aki|dialysis|nephr\w*|uraemi\w*|uremi\w*|oliguri\w*|anuri\w*)\b/i,
    targets: ['excess fluid volume', 'risk for electrolyte imbalance', 'fatigue', 'imbalanced nutrition', 'risk for infection', 'deficient knowledge'], w: 3 },
  { label: 'urinary', re: /\b(uti|urinary|dysuria|retention|catheter\w*|bph|haematuria|hematuria)\b/i,
    targets: ['impaired urinary elimination', 'urinary retention', 'acute pain', 'risk for infection'], w: 2.5 },
  { label: 'anaemia / blood', re: /\b(an[a]?emi\w*|sickle|sca|leuk[a]?emia|thalass\w*|transfusion|bleeding|haemorrhage|hemorrhage|pph)\b/i,
    targets: ['activity intolerance', 'fatigue', 'ineffective peripheral tissue perfusion', 'risk for bleeding', 'deficient fluid volume', 'decreased cardiac output'], w: 3 },
  { label: 'HIV / chronic infection', re: /\b(hiv|aids|retroviral|art)\b/i,
    targets: ['risk for infection', 'imbalanced nutrition', 'fatigue', 'deficient knowledge', 'ineffective coping'], w: 2.5 },
  { label: 'malnutrition', re: /\b(malnutrition|kwashiorkor|marasmus|sam|underweight|wasting|poor feeding|anorexia|failure to thrive)\b/i,
    targets: ['imbalanced nutrition', 'deficient fluid volume', 'risk for infection', 'delayed growth'], w: 3 },
  { label: 'maternal', re: /\b(pregnan\w*|labou?r|antepartum|postpartum|puerper\w*|antenatal|primigravida|multipara|gravida\w*|abortion|miscarriage|ectopic|pph)\b/i,
    targets: ['risk for bleeding', 'acute pain', 'risk for infection', 'deficient knowledge', 'risk for maternal', 'readiness for enhanced childbearing'], w: 2.5 },
  { label: 'neonate / paediatric', re: /\b(neonat\w*|newborn|preterm|premature|birth asphyxia|jaundice|neonatal)\b/i,
    targets: ['neonatal jaundice', 'ineffective thermoregulation', 'hypothermia', 'ineffective infant feeding', 'risk for infection', 'ineffective breathing pattern'], w: 3 },
  { label: 'immobility', re: /\b(bedridden|bed-?bound|immobil\w*|weakness|frail|debilit\w*|elderly|geriatric)\b/i,
    targets: ['impaired physical mobility', 'risk for pressure', 'self-care deficit', 'risk for falls', 'activity intolerance'], w: 2 },
  { label: 'psychiatric', re: /\b(depress\w*|anxiety|psychosis|psychotic|schizophreni\w*|bipolar|mania|agitat\w*|suicid\w*|psychiatric)\b/i,
    targets: ['anxiety', 'ineffective coping', 'disturbed thought', 'risk for self-directed violence', 'risk for other-directed violence', 'insomnia'], w: 3 },
  { label: 'liver / GI bleed', re: /\b(hepatitis|cirrho\w*|liver|ascites|jaundice|hepatic|gi bleed|haematemesis|hematemesis|melaena|melena|peptic|ulcer disease)\b/i,
    targets: ['excess fluid volume', 'imbalanced nutrition', 'risk for bleeding', 'acute pain', 'fatigue'], w: 2.5 },
  { label: 'oedema', re: /\b(oedema|edema|swelling|anasarca)\b/i,
    targets: ['excess fluid volume', 'impaired skin integrity', 'activity intolerance'], w: 2 },
  { label: 'constipation', re: /\b(constipat\w*|obstipation|intestinal obstruction)\b/i,
    targets: ['constipation', 'acute pain', 'nausea'], w: 2.5 }
];

// Vitals thresholds (adult-oriented; paediatric vitals differ, so these add
// modest weight only and are labelled as vitals-based in the reason).
function vitalsHits(v) {
  const hits = [];
  if (!v) return hits;
  const num = (x) => { const n = parseFloat(String(x ?? '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
  const t = num(v.temp), p = num(v.pulse), r = num(v.resp), s = num(v.spo2);
  const bp = /^(\d{2,3})\s*\/\s*(\d{2,3})/.exec(String(v.bp || ''));
  if (t != null && t >= 37.5) hits.push({ label: 'temp ' + t + '\u00B0C', targets: ['hyperthermia', 'deficient fluid volume', 'risk for infection'], w: 3 });
  if (t != null && t < 36.0) hits.push({ label: 'temp ' + t + '\u00B0C', targets: ['hypothermia', 'ineffective thermoregulation'], w: 3 });
  if (s != null && s < 94) hits.push({ label: 'SpO2 ' + s + '%', targets: ['impaired gas exchange', 'ineffective breathing pattern', 'ineffective airway clearance'], w: 3 });
  if (r != null && r > 24) hits.push({ label: 'resp ' + r, targets: ['ineffective breathing pattern', 'impaired gas exchange'], w: 2 });
  if (p != null && p > 110) hits.push({ label: 'pulse ' + p, targets: ['decreased cardiac output', 'deficient fluid volume', 'anxiety'], w: 1.5 });
  if (bp) {
    const sys = +bp[1], dia = +bp[2];
    if (sys >= 140 || dia >= 90) hits.push({ label: 'BP ' + sys + '/' + dia, targets: ['risk for decreased cardiac tissue perfusion', 'ineffective peripheral tissue perfusion', 'risk for injury'], w: 2 });
    if (sys < 90) hits.push({ label: 'BP ' + sys + '/' + dia, targets: ['deficient fluid volume', 'decreased cardiac output', 'ineffective peripheral tissue perfusion'], w: 2.5 });
  }
  return hits;
}

// Drop negated phrases ("no fever", "denies cough", "afebrile") so they don't fire a rule.
function stripNegated(text) {
  return String(text || '')
    .replace(/\b(no|nil|denies|denied|without|not|negative for|absence of)\s+(\w+[\s,/-]+){0,1}\w+/gi, ' ')
    .replace(/\b(afebrile|apyrexial)\b/gi, ' ');
}

const STOP = new Set('with this that from have been were will patient pt admitted admission known case history presenting complaint complains complaining days day weeks week year years old male female the and for was has had under review ward bed'.split(' '));

// patient: a ward-report patient row ({diagnosis, vitalsSnapshot, npPlan, ...}).
// catalog: ensureCatalogLoaded() result ({nanda:[{code,name,domain,cls,definition,...}], ...}).
// Returns up to `max` [{dx, score, reasons[]}], best first. Empty array = nothing matched.
export function suggestDiagnoses(patient, catalog, max = 5) {
  const list = catalog && Array.isArray(catalog.nanda) ? catalog.nanda : [];
  if (!list.length || !patient) return [];

  const text = stripNegated([patient.diagnosis, patient.npPlan].filter(Boolean).join(' \n '));
  const fired = [];
  RULES.forEach((rule) => { if (rule.re.test(text)) fired.push(rule); });
  vitalsHits(patient.vitalsSnapshot).forEach((h) => fired.push(h));

  const score = new Map(); // catalog index -> { score, reasons:Set }
  const add = (i, pts, reason) => {
    const cur = score.get(i) || { score: 0, reasons: new Set() };
    cur.score += pts; if (reason) cur.reasons.add(reason);
    score.set(i, cur);
  };

  const lowerNames = list.map((d) => String(d.name || '').toLowerCase());
  fired.forEach((rule) => {
    rule.targets.forEach((target, rank) => {
      const pts = Math.max(rule.w - rank * 0.3, 0.5);
      lowerNames.forEach((n, i) => { if (n.includes(target)) add(i, pts, rule.label); });
    });
  });

  // Weak fallback so conditions outside the rule table still get something:
  // words from the condition text found inside catalog diagnosis names.
  const words = [...new Set((text.toLowerCase().match(/[a-z]{4,}/g) || []).filter((w) => !STOP.has(w)))];
  if (words.length) {
    lowerNames.forEach((n, i) => {
      const def = String(list[i].definition || '').toLowerCase();
      let pts = 0;
      words.forEach((w) => { if (n.includes(w)) pts += 1; else if (def && def.includes(w)) pts += 0.15; });
      if (pts >= 1) add(i, Math.min(pts, 2), 'wording match');
    });
  }

  return [...score.entries()]
    .map(([i, v]) => ({ dx: list[i], score: v.score, reasons: [...v.reasons] }))
    .sort((a, b) => b.score - a.score || String(a.dx.name).localeCompare(String(b.dx.name)))
    .slice(0, max);
}
