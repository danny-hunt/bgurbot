import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          // Build the populate CLI alongside main; run via `node out/main/populate.js`
          populate: resolve("src/scripts/populate.ts"),
          // Seed CLI: loads the hand-written starter sentences (no LLM)
          seed: resolve("src/scripts/seed.ts"),
        },
      },
    },
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          settings: resolve("src/preload/settings.ts"),
          audio: resolve("src/preload/audio.ts"),
        },
      },
    },
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
      },
    },
    build: {
      rollupOptions: {
        input: {
          settings: resolve("src/renderer/settings/index.html"),
          audio: resolve("src/renderer/audio/index.html"),
          player: resolve("src/renderer/player/index.html"),
        },
      },
    },
  },
});
