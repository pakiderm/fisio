const BASE = process.env.EXPO_PUBLIC_BACKEND_URL;

export const API = `${BASE}/api`;

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
  const res = await fetch(url.toString(), {
    ...init,
    headers: {
      "Content-Type": "application/json",
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
    throw new Error(detail);
  }
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
