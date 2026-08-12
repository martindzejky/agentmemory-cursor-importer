export type AgentmemoryClient = {
  baseUrl: string;
  secret: string;
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

export async function postObserve(
  client: AgentmemoryClient,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; deduplicated?: boolean; error?: string }> {
  const res = await fetch(`${client.baseUrl}/agentmemory/observe`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${client.secret}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
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
    return { ok: false, status: res.status, error: err };
  }

  const deduplicated =
    data && typeof data === "object" && "deduplicated" in data
      ? Boolean((data as { deduplicated?: unknown }).deduplicated)
      : false;

  return { ok: true, status: res.status, deduplicated };
}
