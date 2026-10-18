import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vitest/config";

/**
 * satellite.js bundles an optional WebAssembly engine that Vite cannot build
 * (it uses top-level await and Node worker threads). Aura only needs the plain
 * JavaScript SGP4 functions, so the WebAssembly part is swapped for an empty module.
 */
function satelliteWithoutWasm(): Plugin {
  const STUB = "\0satellite-wasm-stub";
  return {
    name: "satellite-without-wasm",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer?.includes("satellite.js") && /(^|\/)wasm\/index\.js$/.test(source)) return STUB;
      return null;
    },
    load(id) {
      return id === STUB ? "export {};" : null;
    },
  };
}

// In development the browser talks to Vite on :5173 and Vite forwards /api to
// the FastAPI server on :8000, so there is one origin and no CORS to configure.
export default defineConfig({
  plugins: [satelliteWithoutWasm(), react()],
  // MapLibre finds its worker file next to itself; pre-bundling would move it away.
  optimizeDeps: { exclude: ["maplibre-gl"] },
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:8000", changeOrigin: true } },
  },
  build: { chunkSizeWarningLimit: 1500 },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
