import { createContext, useContext, useEffect, useState } from "react";
import { supabase } from "./supabase";

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [session,            setSession]            = useState(null);
  const [loading,            setLoading]            = useState(true);
  const [needsPasswordReset, setNeedsPasswordReset] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session);
      if (event === "PASSWORD_RECOVERY") setNeedsPasswordReset(true);
      if (event === "USER_UPDATED")      setNeedsPasswordReset(false);
      if (event === "SIGNED_OUT")        setNeedsPasswordReset(false);
    });

    // PWA fix: when app returns to foreground after OAuth redirect in Safari,
    // the session is now in localStorage but onAuthStateChange didn't fire.
    // Re-reading the session picks it up.
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        supabase.auth.getSession().then(({ data: { session } }) => setSession(s => s?.access_token === session?.access_token ? s : session));
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => { subscription.unsubscribe(); document.removeEventListener("visibilitychange", onVisible); };
  }, []);

  const signOut = () => supabase.auth.signOut();

  return (
    <AuthCtx.Provider value={{ session, loading, signOut, userId: session?.user?.id ?? null, needsPasswordReset }}>
      {children}
    </AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);
