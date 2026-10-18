// Copies MediaPipe's WebAssembly runtime out of node_modules into public/,
// so the app serves it itself and its version always matches the JS package.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const target = join(root, "public", "mediapipe", "wasm");

if (!existsSync(source)) {
  console.warn("[copy-mediapipe] @mediapipe/tasks-vision is not installed yet; skipping.");
  process.exit(0);
}
mkdirSync(target, { recursive: true });
// The "module" build is only for ES-module workers, which this app doesn't use.
cpSync(source, target, { recursive: true, filter: (path) => !path.includes("_module_") });
console.log("[copy-mediapipe] hand-tracking runtime copied to public/mediapipe/wasm");
