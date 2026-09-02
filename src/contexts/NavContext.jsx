import { createContext, useContext, useState } from "react";

const NavContext = createContext(null);

export function NavProvider({ children }) {
  const [open, setOpen] = useState(false);
  return (
    <NavContext.Provider value={{ open, openDrawer: () => setOpen(true), closeDrawer: () => setOpen(false) }}>
      {children}
    </NavContext.Provider>
  );
}

export function useNav() {
  const ctx = useContext(NavContext);
  if (!ctx) throw new Error("useNav must be used within NavProvider");
  return ctx;
}
