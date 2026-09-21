export default function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer
      style={{
        textAlign: "center",
        padding: "16px 12px",
        fontSize: 13,
        color: "var(--text-muted)",
        borderTop: "1px solid var(--border)",
        marginTop: 24,
      }}
    >
      &copy; {year} Nurse Elite. All rights reserved.
    </footer>
  );
}
