/** Shapes shared across the app. Panel data mirrors what the backend tools return. */
import type { PinchFeel, Sensitivity } from "../config/gestures";
import type { DrawerName } from "../lib/voiceCommands";

export interface GeoPoint {
  lat: number;
  lon: number;
  label: string;
  kind: "city" | "place" | "launch" | "iss";
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

export interface LaunchItem {
  name: string;
  net: string | null;
  status: string;
  status_code: string;
  provider: string;
  rocket: string;
  mission: string;
  mission_description: string;
  orbit: string;
  pad: string;
  location: string;
  lat: number | null;
  lon: number | null;
  image: string | null;
}

export interface IssPosition {
  lat: number;
  lon: number;
  altitude_km: number | null;
  velocity_kmh: number | null;
  visibility: string;
  timestamp: number;
}

export type SpaceData =
  | (PanelBase & {
      type: "space";
      kind: "apod";
      date: string;
      explanation: string;
      image: string | null;
      hd_image: string | null;
      is_video: boolean;
      video_url: string | null;
      credit: string;
    })
  | (PanelBase & { type: "space"; kind: "launches"; items: LaunchItem[] })
  | (PanelBase & { type: "space"; kind: "iss"; position: IssPosition });

export type PanelData = AnswerData | WeatherData | GithubData | NewsData | WikipediaData | SpaceData;

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
  tools: { name: string; description: string }[];
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
