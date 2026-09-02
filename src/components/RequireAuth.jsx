import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext.jsx";

export default function RequireAuth({ children, adminOnly }) {
  const { status, error, profile } = useAuth();
  const location = useLocation();

  if (status === "loading") return null;

  if (status === "signed-out") {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (status === "error") {
    return (
      <div className="container" style={{ maxWidth: 480, marginTop: 60 }}>
        <div className="card-box">
          <div className="error-msg">{error}</div>
        </div>
      </div>
    );
  }

  if (adminOnly && profile?.role !== "admin") {
    return <Navigate to="/" replace />;
  }

  return children;
}
