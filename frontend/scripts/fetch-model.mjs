// Optional: download the hand-tracking model into public/models so the app
// serves it itself. Without this the browser fetches it from Google on first
// use. Run once with:  npm run fetch-model
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const target = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "models", "hand_landmarker.task");

const response = await fetch(MODEL_URL);
if (!response.ok) {
  console.error(`Download failed: HTTP ${response.status}`);
  process.exit(1);
}
const bytes = Buffer.from(await response.arrayBuffer());
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, bytes);
console.log(`Saved ${(bytes.length / 1e6).toFixed(1)} MB to public/models/hand_landmarker.task`);
