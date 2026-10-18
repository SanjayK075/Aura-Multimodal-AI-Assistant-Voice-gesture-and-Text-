/** Everything the frontend asks of the backend. */
import type {
  ActivityEntry,
  ConversationSummary,
  MemoryItem,
  PanelData,
  PlaceRef,
  RunSummary,
  ServerConfig,
  StoredMessage,
} from "../store/types";
import { useStore } from "../store/useStore";
import { createSSEParser } from "./sse";

const prefsSource = () => useStore.getState();

/** Empty locally (Vite proxies /api). Set VITE_API_URL when the backend is on another site. */
const BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");
const CLIENT_KEY = "aura.clientId";

/**
 * A random id for this browser, created once. There are no accounts; the
 * backend uses this to keep each browser's history separate.
 */
export function clientId(): string {
  try {
    let id = localStorage.getItem(CLIENT_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(CLIENT_KEY, id);
    }
    return id;
  } catch {
    return "anonymous-browser";
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function errorFrom(response: Response): Promise<ApiError> {
  let message = `The server returned an error (${response.status}).`;
  try {
    const body = (await response.json()) as { message?: string };
    if (body.message) message = body.message;
  } catch {
    // Not JSON; keep the generic message.
  }
  return new ApiError(message, response.status);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "X-Client-Id": clientId(), ...(init.headers ?? {}) },
    });
  } catch {
    throw new ApiError("Can't reach the server. Check that the backend is running.", 0);
  }
  if (!response.ok) throw await errorFrom(response);
  return (await response.json()) as T;
}

export const api = {
  config: (signal?: AbortSignal) => request<ServerConfig>("/api/config", { signal }),
  conversations: () =>
    request<{ conversations: ConversationSummary[] }>("/api/conversations").then((r) => r.conversations),
  conversation: (id: string) =>
    request<ConversationSummary & { messages: StoredMessage[] }>(`/api/conversations/${encodeURIComponent(id)}`),
  deleteConversation: (id: string) =>
    request<{ deleted: boolean }>(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }),
  clearConversations: () => request<{ deleted: number }>("/api/conversations", { method: "DELETE" }),
  activity: () => request<{ activity: ActivityEntry[] }>("/api/activity?limit=200").then((r) => r.activity),
  /** Run one read-only tool directly, without the language model. */
  tool: (name: string, params: Record<string, string | number | undefined> = {}, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") query.set(key, String(value));
    const { settings } = prefsSource();
    query.set("units", settings.units);
    query.set("news_region", settings.newsRegion);
    if (settings.defaultCity) query.set("default_city", settings.defaultCity);
    if (settings.githubUsername) query.set("github_username", settings.githubUsername);
    return request<ToolResponse>(`/api/tools/${encodeURIComponent(name)}?${query}`, { signal });
  },
  geocode: (q: string) => request<PlaceRef & { name: string }>(`/api/geocode?q=${encodeURIComponent(q)}`),
  runs: () => request<{ runs: RunSummary[] }>("/api/runs").then((r) => r.runs),
  run: (id: string) => request<Record<string, unknown>>(`/api/runs/${encodeURIComponent(id)}`),
  confirm: (runId: string, stepId: string, approved: boolean) =>
    request<{ ok: boolean }>(`/api/runs/${encodeURIComponent(runId)}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step_id: stepId, approved }),
    }),
  memories: () => request<{ memories: MemoryItem[] }>("/api/memories").then((r) => r.memories),
  addMemory: (text: string) =>
    request<MemoryItem>("/api/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }),
  deleteMemory: (id: number) => request<{ deleted: boolean }>(`/api/memories/${id}`, { method: "DELETE" }),
  clearMemories: () => request<{ deleted: number }>("/api/memories", { method: "DELETE" }),
};

export interface ToolResponse {
  name: string;
  args: Record<string, unknown>;
  summary: string;
  source: string;
  source_url: string | null;
  cached: boolean;
  panel: PanelData | null;
}

export interface ChatBody {
  message: string;
  mode?: "auto" | "plan" | "single";
  conversation_id: string | null;
  prefs: {
    default_city: string;
    github_username: string;
    news_region: string;
    units: string;
    timezone: string;
  };
}

/**
 * Send a question and receive the reply as a stream of named events.
 * Resolves when the stream ends; rejects if the request itself fails.
 */
export async function streamChat(
  body: ChatBody,
  onEvent: (event: string, data: Record<string, unknown>) => void,
  signal?: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Client-Id": clientId() },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new ApiError("Can't reach the server. Check that the backend is running.", 0);
  }
  if (!response.ok || !response.body) throw await errorFrom(response);

  const parse = createSSEParser(({ event, data }) => {
    try {
      onEvent(event, JSON.parse(data) as Record<string, unknown>);
    } catch {
      // A malformed event is skipped; the rest of the stream is still usable.
    }
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parse(decoder.decode(value, { stream: true }));
  }
  parse(decoder.decode() + "\n\n");
}
