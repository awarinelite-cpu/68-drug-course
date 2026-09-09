export default function PageLoading() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "40vh",
        width: "100%",
      }}
      role="status"
      aria-label="Loading"
    >
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: "50%",
          border: "3px solid var(--border, #e2e2e2)",
          borderTopColor: "var(--accent, #2563eb)",
          animation: "page-loading-spin 0.7s linear infinite",
        }}
      />
      <style>{`
        @keyframes page-loading-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
