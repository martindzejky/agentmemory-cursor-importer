const API_BASE = "https://api.cursor.com";

export type CursorCloudClient = {
  apiKey: string;
};

export type CloudAgentListItem = {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  repos: Array<{ url: string }>;
};

export type CloudConversationMessage = {
  id: string;
  type: string;
  text: string;
};

type V1ListResponse = {
  items?: unknown;
  nextCursor?: unknown;
};

type V0ConversationResponse = {
  id?: unknown;
  messages?: unknown;
};

function basicAuthHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`, "utf8").toString("base64")}`;
}

async function cursorFetch(
  client: CursorCloudClient,
  path: string,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "GET",
    headers: {
      Authorization: basicAuthHeader(client.apiKey),
      Accept: "application/json",
    },
    signal,
  });
  const body = await res.text();
  return { status: res.status, body };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function parseListItem(raw: unknown): CloudAgentListItem | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const id = asString(obj.id);
  const name = asString(obj.name) ?? "";
  const status = asString(obj.status) ?? "";
  const createdAt = asString(obj.createdAt);
  const updatedAt = asString(obj.updatedAt);
  if (!id || !createdAt || !updatedAt) return null;

  const repos: Array<{ url: string }> = [];
  if (Array.isArray(obj.repos)) {
    for (const entry of obj.repos) {
      if (!entry || typeof entry !== "object") continue;
      const url = asString((entry as { url?: unknown }).url);
      if (url) repos.push({ url });
    }
  }

  return { id, name, status, createdAt, updatedAt, repos };
}

/** Paginate GET /v1/agents (newest first). Includes archived by default. */
export async function listCloudAgents(
  client: CursorCloudClient,
  options: { limitPerPage?: number; signal?: AbortSignal } = {},
): Promise<CloudAgentListItem[]> {
  const limitPerPage = options.limitPerPage ?? 100;
  const out: CloudAgentListItem[] = [];
  let cursor: string | null = null;

  for (;;) {
    const params = new URLSearchParams();
    params.set("limit", String(limitPerPage));
    if (cursor) params.set("cursor", cursor);
    const { status, body } = await cursorFetch(
      client,
      `/v1/agents?${params.toString()}`,
      options.signal,
    );
    if (status !== 200) {
      throw new Error(`GET /v1/agents failed (${status}): ${body.slice(0, 300)}`);
    }

    let data: V1ListResponse;
    try {
      data = JSON.parse(body) as V1ListResponse;
    } catch {
      throw new Error(`GET /v1/agents returned non-JSON: ${body.slice(0, 300)}`);
    }

    const items = Array.isArray(data.items) ? data.items : [];
    for (const item of items) {
      const parsed = parseListItem(item);
      if (parsed) out.push(parsed);
    }

    const next = asString(data.nextCursor);
    if (!next || items.length === 0) break;
    cursor = next;
  }

  return out;
}

export type FetchConversationResult =
  | { ok: true; messages: CloudConversationMessage[] }
  | { ok: false; reason: "deleted" | "http_error"; status: number; detail: string };

/** GET /v0/agents/{id}/conversation — user/assistant text only. */
export async function fetchCloudConversation(
  client: CursorCloudClient,
  agentId: string,
  signal?: AbortSignal,
): Promise<FetchConversationResult> {
  const { status, body } = await cursorFetch(
    client,
    `/v0/agents/${encodeURIComponent(agentId)}/conversation`,
    signal,
  );

  if (status === 409) {
    return { ok: false, reason: "deleted", status, detail: body.slice(0, 300) };
  }
  if (status !== 200) {
    return { ok: false, reason: "http_error", status, detail: body.slice(0, 300) };
  }

  let data: V0ConversationResponse;
  try {
    data = JSON.parse(body) as V0ConversationResponse;
  } catch {
    return {
      ok: false,
      reason: "http_error",
      status,
      detail: `non-JSON body: ${body.slice(0, 300)}`,
    };
  }

  const messages: CloudConversationMessage[] = [];
  const rawMessages = Array.isArray(data.messages) ? data.messages : [];
  for (const raw of rawMessages) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    const id = asString(obj.id);
    const type = asString(obj.type);
    const text = typeof obj.text === "string" ? obj.text : null;
    if (!id || !type || text === null) continue;
    if (type !== "user_message" && type !== "assistant_message") continue;
    if (!text.trim()) continue;
    messages.push({ id, type, text });
  }

  return { ok: true, messages };
}
