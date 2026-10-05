import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";

// Renders the /request-account link as a QR code an admin can print and
// post on the ward — a nurse or doctor scans it with any phone camera to
// open the self-registration form (RequestAccount.jsx). Regenerates
// whenever the page's own origin is known (client-side only, since
// window.location isn't available during any server-side build step).
export default function StaffRegistrationCard({ compact = false }) {
  const canvasRef = useRef(null);
  const link = window.location.origin + '/request-account';
  const [copyMsg, setCopyMsg] = useState('');
  const [shareMsg, setShareMsg] = useState('');


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

  async function shareToWhatsApp() {
    try {
      if (navigator.canShare) {
        // Share the actual QR image (not just the link) so it drops into the
        // WhatsApp chat as a photo the group can screenshot/scan directly.
        const dataUrl = await QRCode.toDataURL(link, { width: 1000, margin: 1 });
        const blob = await (await fetch(dataUrl)).blob();
        const file = new File([blob], 'staff-registration-qr.png', { type: 'image/png' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({
            files: [file],
            title: 'Staff Registration — 68 NARHY Ward Charts',
            text: 'Scan to request a staff account: ' + link,
          });
          return;
        }
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return; // user closed the share sheet — not an error
    }
    // No file-sharing support here (typically a desktop browser) — fall back
    // to opening WhatsApp with the link pre-filled; the QR can still be
    // printed/saved and attached by hand if the group needs the image itself.
    setShareMsg('Sharing the link instead — attach the printed/saved QR image if the group needs the image itself.');
    setTimeout(() => setShareMsg(''), 4000);
    const text = encodeURIComponent('Scan to request a staff account for 68 NARHY Ward Charts: ' + link);
    window.open('https://wa.me/?text=' + text, '_blank');
  }

  async function printCode() {
    // Open the window synchronously (on the click) so popup blockers don't
    // treat it as unsolicited once we await the QR generation below.
    const w = window.open('', '_blank', 'width=420,height=560');
    if (!w) return;

    // Regenerate at high resolution for print rather than reusing the small
    // on-screen canvas, so the code stays sharp when blown up to fill the page.
    const dataUrl = await QRCode.toDataURL(link, { width: 1000, margin: 1 });

    w.document.write(
      '<html><head><title>68 NARHY Ward Charts — Staff Registration</title>' +
      '<style>' +
      '@page { size: A4; margin: 10mm; }' +
      'html, body { height: 100%; margin: 0; }' +
      'body { font-family: sans-serif; text-align: center; box-sizing: border-box; ' +
      'display: flex; flex-direction: column; align-items: center; justify-content: center; }' +
      'h2 { margin: 0 0 6px; font-size: 32px; }' +
      'p.subtitle { margin: 0 0 20px; font-size: 18px; color: #333; }' +
      'img { width: 85vmin; height: 85vmin; max-width: 100%; }' +
      'p.link { font-size: 15px; color: #555; word-break: break-all; margin-top: 22px; }' +
      '</style></head>' +
      '<body>' +
      '<h2>Scan to Request a Staff Account</h2>' +
      '<p class="subtitle">68 NARHY Ward Charts — for nurses and doctors</p>' +
      '<img id="qr" src="' + dataUrl + '" />' +
      '<p class="link">' + link + '</p>' +
      '</body></html>'
    );
    w.document.close();

    // Wait for the image to actually finish loading before printing — with
    // the old code, w.print() fired right after document.write() and the
    // print snapshot could be taken before the data-URL image had painted,
    // leaving a blank box where the QR should be.
    const img = w.document.getElementById('qr');
    const doPrint = () => { w.focus(); w.print(); };
    if (img.complete) doPrint();
    else img.onload = doPrint;
  }

  return (
    <div className={compact ? undefined : "card-box"}>
      {!compact && <h3 style={{ marginTop: 0 }}>Staff Registration</h3>}
      <p style={{ fontSize: 12, color: '#666', marginTop: compact ? 0 : -6 }}>
        {compact
          ? "Let a new nurse or doctor scan this with their phone camera, or share the link. Their application goes to an admin for approval — no sign-in access until approved."
          : "Print this and post it on the ward. A nurse or doctor scans it with their phone camera to fill in their own details and apply for an account — it lands in \"Pending Account Applications\" below for you to approve or reject. No sign-in access until you approve it."}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
        <canvas ref={canvasRef} />
        <div style={{ fontSize: 12, color: '#555', wordBreak: 'break-all', textAlign: 'center' }}>{link}</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
          <button className="btn btn-secondary" onClick={copyLink}>Copy Link</button>
          <button className="btn btn-primary" onClick={printCode}>Print</button>
          <button className="btn btn-secondary" onClick={shareToWhatsApp}>Share to WhatsApp</button>
        </div>
        {copyMsg && <div className="info-msg">{copyMsg}</div>}
        {shareMsg && <div className="info-msg">{shareMsg}</div>}
      </div>
    </div>
  );
}
