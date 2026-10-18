import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The PDF chunk (pdfmake + embedded fonts, ~1.6 MB) is only loaded when a report is exported.
  build: { chunkSizeWarningLimit: 1800 },
  resolve: {
    alias: { "@worker": decodeURIComponent(new URL("../worker/src", import.meta.url).pathname) },
  },
  server: {
    port: 5173,
    // `pnpm dev:web` gives hot reload; the API still runs in `wrangler dev` on :8787.
    proxy: { "/api": "http://localhost:8787" },
  },
});
