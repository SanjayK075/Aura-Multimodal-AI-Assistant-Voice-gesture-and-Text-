/** Shapes shared across the app. Panel data mirrors what the backend tools return. */
import type { PinchFeel, Sensitivity } from "../config/gestures";
import type { DrawerName } from "../lib/voiceCommands";

export interface GeoPoint {
  lat: number;
  lon: number;
  label: string;
  kind: "city" | "place" | "satellite";
}

interface PanelBase {
  title: string;
  source?: string | null;
  source_url?: string | null;
  points?: GeoPoint[];
}

export interface AnswerData extends PanelBase {
  type: "answer";
  text: string;
  question?: string;
}

export interface WeatherDay {
  date: string;
  description: string;
  icon: string;
  max: number | null;
  min: number | null;
  rain_chance: number | null;
  sunrise: string | null;
  sunset: string | null;
}

export interface WeatherData extends PanelBase {
  type: "weather";
  location: { name: string; region: string; country: string; lat: number; lon: number; timezone: string };
  units: { temperature: string; wind: string };
  current: {
    temperature: number | null;
    feels_like: number | null;
    humidity: number | null;
    wind: number | null;
    description: string;
    icon: string;
    is_day: boolean;
    time: string | null;
  };
  daily: WeatherDay[];
  hourly?: { time: string; temperature: number | null; rain_chance: number | null; cloud_cover: number | null }[];
}

export interface RepoItem {
  name: string;
  full_name: string;
  description: string;
  language: string;
  stars: number;
  forks: number;
  open_issues: number;
  updated_at: string | null;
  url: string;
  is_fork: boolean;
  archived: boolean;
}

export interface IssueItem {
  number: number;
  title: string;
  state: string;
  author: string;
  labels: string[];
  comments: number;
  updated_at: string | null;
  url: string;
}

export type GithubData =
  | (PanelBase & { type: "github"; kind: "repos"; username: string; items: RepoItem[] })
  | (PanelBase & { type: "github"; kind: "issues"; repo: string; state: string; items: IssueItem[] });

export interface NewsItem {
  title: string;
  source: string;
  url: string;
  published: string | null;
}

export interface NewsData extends PanelBase {
  type: "news";
  topic: string;
  items: NewsItem[];
}

export interface WikipediaData extends PanelBase {
  type: "wikipedia";
  description: string;
  extract: string;
  url: string;
  thumbnail: string | null;
  featured: boolean;
}

export type SpaceData = PanelBase & {
      type: "space";
      kind: "apod";
      date: string;
      explanation: string;
      image: string | null;
      hd_image: string | null;
      is_video: boolean;
      video_url: string | null;
      credit: string;
    };

export interface PlaceRef {
  name: string;
  region: string;
  country: string;
  lat: number;
  lon: number;
  timezone: string;
}

export interface AirData extends PanelBase {
  type: "air";
  location: PlaceRef;
  aqi: number | null;
  european_aqi: number | null;
  uv_index: number | null;
  category: string;
  level: string;
  advice: string;
  pollutants: { key: string; name: string; label: string; value: number | null; unit: string }[];
  hourly: { time: string; aqi: number | null; pm2_5: number | null }[];
}

export interface OrbitRecord {
  OBJECT_NAME: string;
  NORAD_CAT_ID: number | string;
  [field: string]: unknown;
}

export interface SatellitesData extends PanelBase {
  type: "satellites";
  group: string;
  group_label: string;
  count: number;
  observer: PlaceRef | null;
  overhead: { name: string; norad_id: number | string; elevation: number; azimuth: number; direction: string; alt_km: number }[];
  elements: OrbitRecord[];
  positions: { name: string; lat: number; lon: number; alt_km: number }[];
  computed_at: string;
}

export interface SearchData extends PanelBase {
  type: "search";
  query: string;
  answer: string;
  engine: string;
  items: { title: string; url: string; snippet: string; source: string; published: string | null }[];
}

export interface MemoryItem {
  id: number;
  text: string;
  created_at: string;
}

export interface MemoryData extends PanelBase {
  type: "memory";
  items: MemoryItem[];
  note: string;
}

export type PanelData =
  | AnswerData
  | WeatherData
  | GithubData
  | NewsData
  | WikipediaData
  | SpaceData
  | AirData
  | SatellitesData
  | SearchData
  | MemoryData;

// ---- the planning agent ---------------------------------------------------

export type StepState = "pending" | "running" | "retrying" | "waiting" | "done" | "failed" | "skipped" | "denied";

export interface AgentStep {
  id: string;
  tool: string;
  label: string;
  purpose: string;
  depends_on: string[];
  state: StepState;
  attempts: number;
  started_ms: number | null;
  duration_ms: number | null;
  args: Record<string, unknown>;
  summary: string;
  error: string | null;
  source: string | null;
  cached: boolean;
}

export interface AgentConfirm {
  run_id: string;
  step_id: string;
  tool: string;
  label: string;
  prompt: string;
  args: Record<string, unknown>;
}

export interface AgentRun {
  id: string;
  task: string;
  status: "planning" | "running" | "done" | "error";
  plan: { goal: string; source: string; repairs: number; plan_ms: number; steps: AgentStep[] } | null;
  steps: Record<string, AgentStep>;
  confirm: AgentConfirm | null;
  answer: string;
  timings: { plan_ms: number; execute_ms: number; answer_ms: number } | null;
  latencyMs: number | null;
  startedAt: number;
  panels: PanelData[];
  error: string | null;
}

export interface RunSummary {
  id: string;
  task: string;
  status: string;
  created_at: string;
  step_count: number;
  meta: { latency_ms?: number };
}

export interface Panel {
  id: string;
  /** Groups the panels produced by one question. */
  turnId: string;
  data: PanelData;
  x: number;
  y: number;
  scale: number;
  z: number;
  pinned: boolean;
  /** The assistant's spoken reply about this panel's data. */
  summary: string;
  /** True while the reply is still arriving. */
  streaming: boolean;
}

export type Phase = "idle" | "thinking" | "tool" | "answering" | "speaking" | "error";
export type Connection = "connecting" | "ready" | "unreachable";

export interface ServerConfig {
  version: string;
  provider: string;
  model: string;
  demo: boolean;
  sample_data: boolean;
  max_message_chars: number;
  tools: { name: string; description: string; read_only?: boolean }[];
}

export interface Settings {
  defaultCity: string;
  githubUsername: string;
  newsRegion: string;
  units: "metric" | "imperial";
  /** handsfree: the mic stays on. tap: one question per press of the mic button. */
  voiceMode: "handsfree" | "tap";
  speechLang: string;
  voiceURI: string;
  speechRate: number;
  sensitivity: Sensitivity;
  /** How close the thumb and finger must be to count as a pinch. */
  pinchFeel: PinchFeel;
  /** Resting the cursor on a button for a second clicks it. */
  dwellClick: boolean;
  palmDismiss: boolean;
  showPreview: boolean;
  helpSeen: boolean;
  /** Wave an open hand sideways to flip between pages. */
  swipeNav: boolean;
  /** Only act on speech that starts with "Hey Aura". */
  wakeWord: boolean;
  /** Earth look: photo-real satellite, city lights, or hologram wireframe. */
  earthStyle: "satellite" | "night" | "hologram";
  /** Whether Aura plans multi-part requests (auto), always plans, or never plans. */
  agentMode: "auto" | "plan" | "single";
}

export interface Toast {
  id: number;
  kind: "info" | "error";
  text: string;
}

export interface Caption {
  you: string;
  /** Words recognised so far for an utterance still being spoken. */
  interim: string;
  aura: string;
}

export type { DrawerName };

export interface ConversationSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface StoredMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  panels: PanelData[];
  meta: { followups?: string[]; tools?: { name: string }[]; latency_ms?: number; model?: string };
  created_at: string;
}

export interface ActivityEntry {
  id: number;
  conversation_id: string;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
  source: string;
  duration_ms: number;
  cached: boolean;
  created_at: string;
}
