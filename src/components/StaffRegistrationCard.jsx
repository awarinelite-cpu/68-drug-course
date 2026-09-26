import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";

// Renders the /request-account link as a QR code an admin can print and
// post on the ward — a nurse or doctor scans it with any phone camera to
// open the self-registration form (RequestAccount.jsx). Regenerates
// whenever the page's own origin is known (client-side only, since
// window.location isn't available during any server-side build step).
export default function StaffRegistrationCard() {
  const canvasRef = useRef(null);
  const link = window.location.origin + '/request-account';
  const [copyMsg, setCopyMsg] = useState('');

  useEffect(() => {
    if (canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, link, { width: 220, margin: 2 }, () => {});
    }
  }, [link]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      setCopyMsg('Copied!');
    } catch {
      setCopyMsg('Couldn\u2019t copy — select and copy the link manually.');
    }
    setTimeout(() => setCopyMsg(''), 2500);
  }

  function printCode() {
    const w = window.open('', '_blank', 'width=420,height=560');
    if (!w) return;
    w.document.write(
      '<html><head><title>68 NARHY Ward Charts — Staff Registration</title></head>' +
      '<body style="font-family:sans-serif;text-align:center;padding:24px;">' +
      '<h2>Scan to Request a Staff Account</h2>' +
      '<p>68 NARHY Ward Charts — for nurses and doctors</p>' +
      '<img src="' + canvasRef.current.toDataURL('image/png') + '" style="width:280px;height:280px;" />' +
      '<p style="font-size:12px;color:#555;word-break:break-all;">' + link + '</p>' +
      '</body></html>'
    );
    w.document.close();
    w.focus();
    w.print();
  }

  return (
    <div className="card-box">
      <h3 style={{ marginTop: 0 }}>Staff Registration</h3>
      <p style={{ fontSize: 12, color: '#666', marginTop: -6 }}>
        Print this and post it on the ward. A nurse or doctor scans it with their phone camera to fill in
        their own details and apply for an account — it lands in "Pending Account Applications" below for
        you to approve or reject. No sign-in access until you approve it.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
        <canvas ref={canvasRef} />
        <div style={{ fontSize: 12, color: '#555', wordBreak: 'break-all', textAlign: 'center' }}>{link}</div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-secondary" onClick={copyLink}>Copy Link</button>
          <button className="btn btn-primary" onClick={printCode}>Print</button>
        </div>
        {copyMsg && <div className="info-msg">{copyMsg}</div>}
      </div>
    </div>
  );
}
