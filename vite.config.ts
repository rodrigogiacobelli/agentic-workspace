import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port and ignores the vite dev-server host in prod builds.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    // Vite 8 minifies with oxc; naming esbuild here takes a deprecated path.
    target: "es2022",
    sourcemap: false,
  },
});
