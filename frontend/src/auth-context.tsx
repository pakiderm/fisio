import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Platform } from "react-native";

import { API, storeToken, getStoredToken, clearStoredToken } from "@/src/api";

export interface AuthUser {
  id: string;
  email: string | null;
  first_name: string;
  last_name: string;
  picture: string | null;
  auth_providers: string[];
}

interface AuthState {
  loading: boolean;
  user: AuthUser | null;
  signIn: (email: string, password: string) => Promise<void>;
  register: (
    email: string,
    password: string,
    first_name: string,
    last_name: string,
  ) => Promise<void>;
  signInWithGoogleSessionId: (sessionId: string) => Promise<void>;
  signInWithApple: (
    identityToken: string,
    nonce?: string,
    first_name?: string,
    last_name?: string,
  ) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

async function callAuth(path: string, body: any) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    throw new Error(data?.detail || `Errore ${res.status}`);
  }
  return data;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);

  const loadMe = useCallback(async () => {
    const token = await getStoredToken();
    if (!token) {
      setUser(null);
      return;
    }
    try {
      const res = await fetch(`${API}/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        await clearStoredToken();
        setUser(null);
        return;
      }
      const me = await res.json();
      setUser(me);
    } catch {
      await clearStoredToken();
      setUser(null);
    }
  }, []);

  useEffect(() => {
    (async () => {
      await loadMe();
      setLoading(false);
    })();
  }, [loadMe]);

  const applyAuth = async (data: any) => {
    await storeToken(data.session_token);
    setUser(data.user);
    qc.clear();
  };

  const value = useMemo<AuthState>(
    () => ({
      loading,
      user,
      signIn: async (email, password) => {
        const data = await callAuth("/auth/login", { email, password });
        await applyAuth(data);
      },
      register: async (email, password, first_name, last_name) => {
        const data = await callAuth("/auth/register", {
          email,
          password,
          first_name,
          last_name,
        });
        await applyAuth(data);
      },
      signInWithGoogleSessionId: async (sessionId) => {
        const data = await callAuth("/auth/session", { session_id: sessionId });
        await applyAuth(data);
      },
      signInWithApple: async (identity_token, nonce, first_name, last_name) => {
        const data = await callAuth("/auth/apple", {
          identity_token,
          nonce,
          first_name,
          last_name,
        });
        await applyAuth(data);
      },
      signOut: async () => {
        const token = await getStoredToken();
        if (token) {
          try {
            await fetch(`${API}/auth/logout`, {
              method: "POST",
              headers: { Authorization: `Bearer ${token}` },
            });
          } catch {}
        }
        await clearStoredToken();
        setUser(null);
        qc.clear();
      },
      refresh: loadMe,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loading, user],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
