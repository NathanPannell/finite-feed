export type JsonRecord = Record<string, unknown>;

export type PageResult<T extends JsonRecord = JsonRecord> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export class AdminApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
  }
}

function errorMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object") {
    const record = payload as JsonRecord;
    const detail = record.detail ?? record.message ?? record.error;
    if (typeof detail === "string" && detail.trim()) return detail;
  }
  return fallback;
}

export async function adminRequest<T>(
  path: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/admin/${path.replace(/^\/+/, "")}`, {
    ...init,
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
    signal,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new AdminApiError(errorMessage(payload, `Request failed (${response.status}).`), response.status);
  }
  return payload as T;
}

export function pageResult<T extends JsonRecord>(
  payload: unknown,
  fallbackPage: number,
  fallbackPageSize: number,
): PageResult<T> {
  if (Array.isArray(payload)) {
    return { items: payload as T[], total: payload.length, page: fallbackPage, pageSize: fallbackPageSize };
  }
  const record = (payload && typeof payload === "object" ? payload : {}) as JsonRecord;
  const items = Array.isArray(record.items) ? record.items : [];
  return {
    items: items as T[],
    total: typeof record.total === "number" ? record.total : items.length,
    page: typeof record.page === "number" ? record.page : fallbackPage,
    pageSize:
      typeof record.page_size === "number"
        ? record.page_size
        : typeof record.pageSize === "number"
          ? record.pageSize
          : fallbackPageSize,
  };
}
