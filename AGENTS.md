# Project Nixie

Top-down procedural cyberpunk city generator for Foundry VTT (target v12; forward-compatible v13/v14).

## Stack & Commands

- **Stack:** TypeScript 5.9, Vite 7.3, Vitest 3.2, PIXI 7.4.2/7.4.3, WebGL2/GLSL ES 1.00/3.00, Web Worker.
- `npm test` — Fast test suite (76 files, ~1,065 tests, ~90s). Run frequently.
- `npm run test:acceptance` — Heavy full-city acceptance suite (`complete-city-plan.test.ts`, ~8.5m). Run only when needed or closing major milestones.
- `npm run test:watch` — Fast-tier watch mode.
- `npm run typecheck` — TypeScript typecheck without emit (`tsc --noEmit`).
- `npm run build` — Dual-bundle production build (`dist/project-nixie.mjs` + `dist/nixie-worker.mjs`).
- `npm run watch` — Polling watch build. Requires `NIXIE_WATCH=1`.
- **CIFS Environment:** Mounted over CIFS (`symlink=none`, `npm install --no-bin-links`) to server hosting project files and Foundry server.
- **Visual Verification (CDP):** Chromium with CDP on port `9222` is usually available for visual inspection. Requires hard reload (cache bypass) or modules load stale. If port 9222 is down, ask the user to launch it.
- **Test Concurrency:** Heavy tests must use explicit timeouts (`120_000` ms) to prevent flakes under worker CPU contention.

## Repository Map

- `src/core/` — Pure geometry, graph algorithms, procedural generators, registries. **Zero Foundry/PIXI imports**.
  - `src/core/gen/` — City planners (`complete-city-plan.ts`), chunk builders (`complete-city-chunk.ts`), registries (`building-registry.ts`, `landmark-registry.ts`, `district-registry.ts`).
  - `src/core/geom/` — Polygon clipping (`boolean.ts`), tessellation (`tessellate.ts`), simplification (`simplify.ts`), mesh buffers (`mesh.ts`).
  - `src/core/graph/` — Road network topology (`topology.ts`), simple-curve polyline compiler (`compiler.ts`).
- `src/render/` — Shaders (`shaders/`), bloom, culling, token foot probe, city renderer. Pure PIXI/GL; no Foundry document imports.
- `src/adapter/` — Foundry bridge (`canvas.ts`, `documents.ts`, `terrain-session.ts`, `generated-walls.ts`).
- `src/worker/` — Web worker client, transport protocol (`protocol.ts`), worker entry (`nixie-worker.ts`).
- `src/ui/` — Shared editor shell (`editor-shell.ts`), interaction layers (`nixie-layer.ts`, `road-layer.ts`, `district-layer.ts`).
  - `src/ui/workspaces/` — Workspaces: `generate.ts`, `terrain.ts`, `roads.ts`, `districts.ts`, `diagnostics.ts`, `unavailable.ts` (Phase 5–8 placeholders).
- **Foundry Codebases (Read-Only Reference):**
  - `/mnt/sataSSD/fvtt/fcyberV12` — Foundry VTT v12 source (check v12 APIs/internals).
  - `/mnt/sataSSD/fvtt/fviraV14` — Foundry VTT v14 source (check v14 APIs/ApplicationV2).

## Architecture Overview

- **Deterministic:** Seeded FNV-1a PRNG generates reproducible terrain, roads, districts, blocks, parcels, buildings, landmarks, clutter, and neon.
- **Coordinates:** Metre-based coordinates relative to scene world-pixel origin.
- **Persistence:** Scene flag `project-nixie.city` (`CityStateV3`, Schema 3 / Generator 11) is the sole source of truth. Derived geometry is never persisted.
- **Chunking:** Regular 128m metre-grid chunks (`CHUNK_SIZE_M = 128`).
- **Worker Pipeline:** Heavy city planning and chunk meshing run off-thread with transferable `Float32Array`/`Uint32Array` buffers.
- **Wall Documents:** Debounced (400ms) whole-city corridor walls flagged `project-nixie.generated = true` with integer world coordinates. Never modifies hand-drawn walls.
- **UI Shell:** Single top-centre frameless `ApplicationV2` (`editor-shell.ts`) with session-only state.

## Sources of Truth

- `docs/` is authoritative.
- `docs/DOCUMENTATION.md` — Current implemented engine, APIs, shaders, conventions, traps.
- `docs/CITY_GENERATOR_2.0_SPEC.md` — Product specifications, geometric rules, object model invariants.
- `docs/CITY_GENERATOR_2.0_UI_SPEC.md` — UI layout, interactions, tool behaviors.
- `docs/CITY_GENERATOR_2.0_IMPLEMENTATION_OVERVIEW.md` — Phase boundaries, prerequisites, roadmap status.

## Gotchas & Quirks

- **CIFS Mount:** No `.bin/` symlinks exist; npm scripts must invoke `node node_modules/<pkg>/...`. `NIXIE_WATCH=1` is required for watcher polling.
- **Two-Environment Build:** `vite.config.ts` uses two environments to prevent shared code from hoisting into an illegal third bundle (`consumer: "client"`).
- **Shader Constraints:** No `discard` in main city mesh (destroys early-Z). No `fwidth`/derivatives (unsupported on target). Vertical AA must use `vUpPxPerMetre` (pinhole squashes height).
- **Stationary Frame Cache:** `CityRenderer.update` skips draw when camera is stationary and clean; settled frame pays detail/supersample costs once.
- **Setting Clamping Trap:** Foundry setting `range` silently clamps inputs. `rainStrength` intentionally has no range to allow unbounded values.
- **Persistence Safety:** Schema 1/2 and Gen 10 data are `obsolete-precomplete`; they are read-only and must never be quietly overwritten without explicit confirmed replacement.
- **Foundry Layers:** Custom layers extend `InteractionLayer` via factory functions to avoid top-level global resolution errors on v12.
- **CDP Bundle Caching:** Browser aggressively caches `.mjs` modules over HTTP; trigger a hard cache-bypass reload after builds.

## Performance Target

- **Target:** **30 FPS panning at 1440×1440 on AMD Radeon 780M iGPU** (~33.3 ms frame budget, <450k visible triangles).
- *Context:* Historical 20 FPS @ 3440×1440 target was relaxed because agents were overly conservative, creating sparse/plain visuals that ran at 120 FPS at 4K. Aim for rich visual density within the 30 FPS budget. This performance target is a soft one, if not meeting it would produce substantially better visuals - tell the user what you are doing and proceed. 
