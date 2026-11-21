// The iOS app's Simulator checks. Run them with `pnpm mobile:check`, which
// gives them a device, a build and a gateway instance of their own; listing
// them (as the parity check does) runs nothing. The checks are steps of one
// session with the app, in order, so they run one at a time.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["*.test.ts"],
    fileParallelism: false,
    // A pairing request left to expire, or a run, can take long on a loaded machine.
    testTimeout: 45 * 60_000,
    hookTimeout: 5 * 60_000,
    bail: 1,
  },
});
