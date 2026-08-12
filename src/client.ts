export type AgentmemoryClient = {
  baseUrl: string;
  secret: string;
};

/** Server max for POST /agentmemory/observe/bulk (PR #19). */
export const OBSERVE_BULK_MAX = 500;

export type BulkObserveResult = {
  ok: boolean;
  status: number;
  imported: number;
  deduplicated: number;
  failed: number;
  errors: Array<{ index?: number; eventId?: string; error: string }>;
  error?: string;
};

export async function listSessionIds(client: AgentmemoryClient): Promise<Set<string>> {
  const res = await fetch(`${client.baseUrl}/agentmemory/replay/sessions`, {
    headers: {
      Authorization: `Bearer ${client.secret}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`list sessions failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { sessions?: Array<{ id?: string }> };
  const ids = new Set<string>();
  for (const session of body.sessions ?? []) {
    if (typeof session.id === "string" && session.id) ids.add(session.id);
  }
  return ids;
}

export async function postObserveBulk(
  client: AgentmemoryClient,
  observations: Record<string, unknown>[],
): Promise<BulkObserveResult> {
  const res = await fetch(`${client.baseUrl}/agentmemory/observe/bulk`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${client.secret}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ observations }),
  });

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const err =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `HTTP ${res.status}`;
    return {
      ok: false,
      status: res.status,
      imported: 0,
      deduplicated: 0,
      failed: observations.length,
      errors: [{ error: err }],
      error: err,
    };
  }

  const body = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const errorsRaw = Array.isArray(body.errors) ? body.errors : [];
  const errors = errorsRaw.map((item) => {
    const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    return {
      index: typeof row.index === "number" ? row.index : undefined,
      eventId: typeof row.eventId === "string" ? row.eventId : undefined,
      error: typeof row.error === "string" ? row.error : "unknown error",
    };
  });

  return {
    ok: true,
    status: res.status,
    imported: typeof body.imported === "number" ? body.imported : 0,
    deduplicated: typeof body.deduplicated === "number" ? body.deduplicated : 0,
    failed: typeof body.failed === "number" ? body.failed : 0,
    errors,
  };
}

export function chunkObservations<T>(items: T[], size = OBSERVE_BULK_MAX): T[][] {
  if (size <= 0) throw new Error("chunk size must be positive");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
