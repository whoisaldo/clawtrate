import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { updateDefines } from "./packaging/update-defines.ts";

export default defineConfig({
  main: {
    // The update feed's address and the build's own release date, fixed here
    // for the update engine; docs/decisions.md, "Updates and release signing".
    define: updateDefines(process.env, new Date()),
    // Workspace packages ship TypeScript source, so they are bundled rather than required;
    // so is `ws`, which setup's synthetic gateway uses: the packaged app carries no
    // node_modules, and a build outside the checkout reaches none.
    build: { externalizeDeps: { exclude: ["@clawtrate/core", "@clawtrate/ui", "ws"] } },
  },
  preload: {
    build: {
      externalizeDeps: { exclude: ["@clawtrate/core"] },
      // A sandboxed preload must be CommonJS.
      rolldownOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    root: "src/renderer",
    plugins: [react()],
    build: { rolldownOptions: { input: "src/renderer/index.html" } },
  },
});
