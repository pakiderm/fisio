import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL;

export const API = `${BASE}/api`;

const TOKEN_KEY = "fisiomanager_session_token";
let memoryToken: string | null = null;

export async function getStoredToken(): Promise<string | null> {
  if (memoryToken) return memoryToken;
  try {
    if (Platform.OS === "web") {
      memoryToken = typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null;
    } else {
      memoryToken = await SecureStore.getItemAsync(TOKEN_KEY);
    }
  } catch {
    memoryToken = null;
  }
  return memoryToken;
}

export async function storeToken(token: string): Promise<void> {
  memoryToken = token;
  try {
    if (Platform.OS === "web") {
      if (typeof localStorage !== "undefined") localStorage.setItem(TOKEN_KEY, token);
    } else {
      await SecureStore.setItemAsync(TOKEN_KEY, token);
    }
  } catch {}
}

export async function clearStoredToken(): Promise<void> {
  memoryToken = null;
  try {
    if (Platform.OS === "web") {
      if (typeof localStorage !== "undefined") localStorage.removeItem(TOKEN_KEY);
    } else {
      await SecureStore.deleteItemAsync(TOKEN_KEY);
    }
  } catch {}
}

async function request<T>(
  path: string,
  init?: RequestInit & { params?: Record<string, string | number | undefined> },
): Promise<T> {
  const url = new URL(`${API}${path}`);
  if (init?.params) {
    Object.entries(init.params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    });
  }
  const token = await getStoredToken();
  const res = await fetch(url.toString(), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try {
      const j = JSON.parse(text);
      detail = j.detail ?? text;
    } catch {}
    const err = new Error(detail) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T,>(path: string, params?: Record<string, string | number | undefined>) =>
    request<T>(path, { method: "GET", params }),
  post: <T,>(path: string, body?: any) =>
    request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  put: <T,>(path: string, body?: any) =>
    request<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined }),
  delete: <T,>(path: string, params?: Record<string, string | number | undefined>) =>
    request<T>(path, { method: "DELETE", params }),
};

export const downloadUrl = (invoiceId: string, fmt: "xlsx" | "pdf") =>
  `${API}/invoices/${invoiceId}/download?fmt=${fmt}`;
