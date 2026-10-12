import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the API runs on :8080; the dev server proxies /api so the
// session cookie stays same-origin. In production the API serves dist/.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": { target: "http://127.0.0.1:8080", changeOrigin: false } } },
  build: { outDir: "dist", sourcemap: true, chunkSizeWarningLimit: 600 },
});
