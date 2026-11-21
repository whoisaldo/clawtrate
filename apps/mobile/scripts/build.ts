// `pnpm mobile:build`: a Release build of the iOS app for the Simulator. No
// signing identity, no Apple account and no Expo account: `expo prebuild`
// writes the native project from app.json (it is not committed), CocoaPods
// installs the native modules, and xcodebuild builds for the Simulator, which
// signs the app ad hoc. The JavaScript is bundled into the app, so it runs
// without Metro.

import { spawnSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync } from "node:fs";
import { arch } from "node:os";
import { join } from "node:path";
import { findDeveloperDir } from "./xcode.ts";

export const APP_DIR = join(import.meta.dirname, "..");
export const BUILD_DIR = join(APP_DIR, "build");
export const APP_PATH = join(
  BUILD_DIR,
  "DerivedData/Build/Products/Release-iphonesimulator/Clawtrate.app",
);
export const BUNDLE_ID = "dev.clawtrate.mobile";

function run(
  step: string,
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  log: string,
) {
  console.log(`${step}…`);
  const out = openSync(log, "w");
  const result = spawnSync(command, args, { cwd, env, stdio: ["ignore", out, out] });
  if (result.status !== 0) {
    const tail = readFileSync(log, "utf8").split("\n").slice(-40).join("\n");
    throw new Error(
      `${step} failed (${result.error?.message ?? `exit ${result.status}`}); the log is ${log}:\n${tail}`,
    );
  }
}

export function build(): string {
  const developerDir = findDeveloperDir();
  mkdirSync(BUILD_DIR, { recursive: true });
  const env = {
    ...process.env,
    DEVELOPER_DIR: developerDir,
    EXPO_NO_TELEMETRY: "1",
    CI: "1",
    COCOAPODS_DISABLE_STATS: "true",
    LANG: process.env.LANG ?? "en_US.UTF-8",
  };
  console.log(`Xcode: ${developerDir}`);
  run(
    "expo prebuild",
    "pnpm",
    ["exec", "expo", "prebuild", "--platform", "ios", "--no-install"],
    APP_DIR,
    env,
    join(BUILD_DIR, "prebuild.log"),
  );
  run(
    "pod install",
    "pod",
    ["install"],
    join(APP_DIR, "ios"),
    env,
    join(BUILD_DIR, "pod-install.log"),
  );
  run(
    "xcodebuild (several minutes)",
    "xcodebuild",
    [
      "-workspace",
      "Clawtrate.xcworkspace",
      "-scheme",
      "Clawtrate",
      "-configuration",
      "Release",
      "-sdk",
      "iphonesimulator",
      "-destination",
      "generic/platform=iOS Simulator",
      "-derivedDataPath",
      join(BUILD_DIR, "DerivedData"),
      `ARCHS=${arch() === "arm64" ? "arm64" : "x86_64"}`,
      "ONLY_ACTIVE_ARCH=YES",
      "build",
    ],
    join(APP_DIR, "ios"),
    env,
    join(BUILD_DIR, "xcodebuild.log"),
  );
  console.log(`Built ${APP_PATH}`);
  return APP_PATH;
}

if (process.argv[1] === import.meta.filename) {
  try {
    build();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
