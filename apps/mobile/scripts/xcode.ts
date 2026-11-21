// Which Xcode the iOS build and checks use. `DEVELOPER_DIR` wins when it is set;
// otherwise the one `xcode-select` points at, when that is an Xcode and not the
// command line tools; otherwise the newest Xcode under /Applications. Expo SDK 58
// needs Xcode 27 or later: its JSI module is written for Swift 6.4 and does not
// compile with Xcode 26's Swift 6.2.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const MIN_XCODE_MAJOR = 27;

/** The major version of the Xcode at a developer directory, or null when there is none. */
export function xcodeMajor(developerDir: string): number | null {
  try {
    const out = execFileSync("xcodebuild", ["-version"], {
      env: { ...process.env, DEVELOPER_DIR: developerDir },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const major = /^Xcode (\d+)/m.exec(out)?.[1];
    return major ? Number(major) : null;
  } catch {
    return null;
  }
}

export function findDeveloperDir(env: NodeJS.ProcessEnv = process.env): string {
  const candidates: string[] = [];
  if (env.DEVELOPER_DIR) candidates.push(env.DEVELOPER_DIR);
  else {
    try {
      const selected = execFileSync("xcode-select", ["-p"], { encoding: "utf8" }).trim();
      if (selected.includes(".app/")) candidates.push(selected);
    } catch {
      // No selection; look in /Applications.
    }
    if (existsSync("/Applications")) {
      const apps = readdirSync("/Applications")
        .filter((name) => /^Xcode.*\.app$/.test(name))
        .map((name) => join("/Applications", name, "Contents/Developer"));
      candidates.push(...apps.sort().reverse());
    }
  }
  const usable = candidates
    .map((dir) => ({ dir, major: xcodeMajor(dir) }))
    .filter(
      (c): c is { dir: string; major: number } => c.major !== null && c.major >= MIN_XCODE_MAJOR,
    )
    .sort((a, b) => b.major - a.major);
  // An explicit DEVELOPER_DIR is used as given, or refused; never replaced by another.
  if (env.DEVELOPER_DIR && usable[0]?.dir !== env.DEVELOPER_DIR)
    throw new Error(
      `DEVELOPER_DIR (${env.DEVELOPER_DIR}) is not Xcode ${MIN_XCODE_MAJOR} or later.`,
    );
  if (!usable[0])
    throw new Error(`No Xcode ${MIN_XCODE_MAJOR} or later was found. Set DEVELOPER_DIR to one.`);
  return usable[0].dir;
}
