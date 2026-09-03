import Topbar from "./Topbar.jsx";

// Minimal placeholder — replaced with the full thread view (send/receive,
// read receipts, typing, reactions, attachments) in a follow-up commit.
export default function ChatThread({ onBack }) {
  return (
    <>
      <Topbar brand="Messages">
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={onBack}>Back</button>
      </Topbar>
      <div className="container">
        <div className="card-box">
          <div className="loading-note">Opening chat…</div>
        </div>
      </div>
    </>
  );
}
