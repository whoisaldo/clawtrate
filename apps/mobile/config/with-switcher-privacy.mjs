import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import plugins from "expo/config-plugins";

const { IOSConfig, withDangerousMod } = plugins;
const START = "  // BEGIN Clawtrate switcher privacy";
const END = "  // END Clawtrate switcher privacy";
const EXTENSION_POINT = "  // Extension point for config plugins.";

export default function withSwitcherPrivacy(config) {
  return withDangerousMod(config, [
    "ios",
    (config) => {
      const { projectRoot } = config.modRequest;
      const sourceRoot = IOSConfig.Paths.getSourceRoot(projectRoot);
      const file = join(sourceRoot, "SceneDelegate.swift");
      const source = readFileSync(file, "utf8");
      const original = source.replace(new RegExp(`${START}[\\s\\S]*?${END}`), EXTENSION_POINT);
      if (!original.includes(EXTENSION_POINT) || !original.includes(": ExpoAppSceneDelegate {")) {
        throw new Error(
          "Expo's SceneDelegate template changed. Update the switcher privacy plugin.",
        );
      }
      const privacy = readFileSync(
        new URL("./switcher-privacy.swift", import.meta.url),
        "utf8",
      ).trimEnd();
      const imports = original.includes("import UIKit") ? original : `import UIKit\n${original}`;
      writeFileSync(file, imports.replace(EXTENSION_POINT, `${START}\n${privacy}\n${END}`));

      // The cover uses the same brand mark as the React Native screens.
      const mark = join(sourceRoot, "Images.xcassets", "PrivacyMark.imageset");
      mkdirSync(mark, { recursive: true });
      copyFileSync(join(projectRoot, "assets", "logo-mark.png"), join(mark, "mark.png"));
      writeFileSync(
        join(mark, "Contents.json"),
        JSON.stringify({
          images: [{ filename: "mark.png", idiom: "universal", scale: "3x" }],
          info: { author: "xcode", version: 1 },
        }),
      );
      return config;
    },
  ]);
}
