import { useNavigate } from "react-router-dom";

// Shared "Back" behavior for every page's Back button: step back through real
// browser history (so patient context and previous pages are preserved),
// falling back to a given path only when there's nowhere to go back to.
export function useGoBack(fallbackPath) {
  const navigate = useNavigate();
  return () => {
    if (window.history.length > 1) navigate(-1);
    else navigate(fallbackPath);
  };
}
