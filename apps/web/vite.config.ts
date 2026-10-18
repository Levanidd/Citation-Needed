import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@worker": decodeURIComponent(new URL("../worker/src", import.meta.url).pathname) },
  },
  server: {
    port: 5173,
    // `pnpm dev:web` gives hot reload; the API still runs in `wrangler dev` on :8787.
    proxy: { "/api": "http://localhost:8787" },
  },
});
