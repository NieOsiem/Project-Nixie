/// <reference types="vitest/config" />
import { defineConfig, type LibraryOptions } from "vite";

const watching = Boolean(process.env.NIXIE_WATCH);

const lib = (name: string, entry: string): LibraryOptions => ({
  entry,
  formats: ["es"],
  fileName: () => `${name}.mjs`
});

export default defineConfig({
  build: {
    target: "es2022",
    outDir: "dist",
    // WHY: only the environment that runs first may clear dist, and in watch mode none may —
    // a rebuild of one entry would delete the other entry's output and never restore it.
    emptyOutDir: !watching,
    sourcemap: true,
    minify: false,
    // WHY: the module lives on a CIFS share, which delivers no inotify events.
    // Watch mode has to poll or it silently never rebuilds.
    watch: watching ? { chokidar: { usePolling: true, interval: 400 } } : null
  },
  // WHY: one Rollup pass over both entries hoists code they share into a third chunk that the
  // worker bundle then fetches at runtime inside Foundry. One build per entry duplicates the
  // shared code instead, so each bundle is a single self-contained file.
  environments: {
    client: { build: { lib: lib("project-nixie", "src/main.ts") } },
    worker: {
      // WHY: any environment not named "client" defaults to consumer "server", which
      // externalises node_modules and would leave bare imports in the worker bundle.
      consumer: "client",
      build: { emptyOutDir: false, lib: lib("nixie-worker", "src/worker/nixie-worker.ts") }
    }
  },
  builder: {
    buildApp: async (builder) => {
      await builder.build(builder.environments.client!);
      await builder.build(builder.environments.worker!);
    }
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node"
  }
});
