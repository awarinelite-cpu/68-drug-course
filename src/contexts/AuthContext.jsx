import { createContext, useContext, useEffect, useState } from "react";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "../firebase.js";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  // 'loading' | 'ready' | 'signed-out' | 'error'
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        setUser(null);
        setProfile(null);
        setStatus("signed-out");
        return;
      }

      const userRef = doc(db, "users", u.uid);
      let snap;
      try {
        snap = await getDoc(userRef);
      } catch (e) {
        setError("Couldn't reach the database: " + (e.code || e.message || 'unknown error') +
          " — make sure Firestore Database has been created for this Firebase project.");
        setStatus("error");
        return;
      }

      // Every account has to be created by an admin (via the Admin page) —
      // there's no self-service signup and no seed-admin bootstrap, so a
      // signed-in Firebase Auth user with no matching Firestore profile
      // means their account isn't fully set up yet.
      if (!snap.exists()) {
        setError("Your account isn't set up yet. Please contact your admin.");
        setStatus("error");
        await signOut(auth);
        return;
      }

      setUser(u);
      setProfile(snap.data());
      setStatus("ready");
    });
    return unsub;
  }, []);

  function updateLocalProfile(patch) {
    setProfile((p) => ({ ...p, ...patch }));
  }

  function logout() {
    return signOut(auth);
  }

  return (
    <AuthContext.Provider value={{ user, profile, status, error, logout, updateLocalProfile }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
