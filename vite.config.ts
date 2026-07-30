/// <reference types="vitest/config" />
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    lib: {
      entry: {
        "project-nixie": "src/main.ts",
        "nixie-worker": "src/worker/nixie-worker.ts"
      },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.mjs`
    },
    // WHY: the module lives on a CIFS share, which delivers no inotify events.
    // Watch mode has to poll or it silently never rebuilds.
    watch: process.env.NIXIE_WATCH ? { chokidar: { usePolling: true, interval: 400 } } : null
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node"
  }
});
