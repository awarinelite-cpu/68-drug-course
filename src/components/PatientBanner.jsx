const NO_ALLERGY_RE = /^(none|nil|none known)$/i;

export default function PatientBanner({ patient, extra }) {
  const allergy = (patient?.allergies || "").trim();
  const showAllergy = allergy && !NO_ALLERGY_RE.test(allergy);
  return (
    <>
      <div className="patient-banner">
        <div>
          <div className="pname">{patient ? (patient.name || "Unnamed") : "Loading…"}</div>
          <div className="pmeta">
            {patient ? "EMR: " + (patient.emr || "N/A") + "   |   Diagnosis: " + (patient.diagnosis || "Not specified") : ""}
          </div>
        </div>
        {extra}
      </div>
      {showAllergy && <div className="allergy-alert">ALLERGY ALERT: {allergy}</div>}
    </>
  );
}
