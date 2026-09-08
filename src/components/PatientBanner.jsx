const NO_ALLERGY_RE = /^(none|nil|none known)$/i;

export default function PatientBanner({ patient, extra, boxes, ward }) {
  const allergy = (patient?.allergies || "").trim();
  const showAllergy = allergy && !NO_ALLERGY_RE.test(allergy);
  return (
    <>
      <div className="patient-banner">
        <div className="patient-banner-row1">
          <div>
            <div className="pname">{patient ? (patient.name || "Unnamed") : "Loading…"}</div>
            <div className="pmeta">
              {patient ? "EMR: " + (patient.emr || "N/A") + "   |   Diagnosis: " + (patient.diagnosis || "Not specified") : ""}
            </div>
            {ward && <div className="pward">Ward: {ward}</div>}
          </div>
          {boxes && <div className="patient-banner-boxes">{boxes}</div>}
        </div>
        {extra && <div className="patient-banner-row2">{extra}</div>}
      </div>
      {showAllergy && <div className="allergy-alert">ALLERGY ALERT: {allergy}</div>}
    </>
  );
}
