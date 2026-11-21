# The iOS app

`apps/mobile` is the iOS app (Expo SDK 58, React Native 0.88). It runs the same `packages/core` as the desktop app. Building and checking it needs a Mac with:

- Xcode 27 or later and an iOS Simulator runtime with an iPhone 17, 16, 17 Pro or 18 Pro. Neither `xcode-select` nor sudo is needed: the scripts use `DEVELOPER_DIR` when it is set, otherwise the Xcode `xcode-select` points at, otherwise the newest Xcode in `/Applications`. Xcode 26 does not compile Expo SDK 58.
- CocoaPods (1.17 was used).
- For the checks: a Java runtime, 17 or later, and Maestro. They were run with Temurin JRE 21.0.13 and Maestro 2.12.1, unpacked without sudo into `~/.local/share/temurin-jre-21.0.13` and `~/.local/share/maestro-2.12.1`, where the check finds them; elsewhere, set `JAVA_HOME` and `MAESTRO` (the `maestro` executable). Maestro 2.12.1 checks its servers for a newer version and can send an error report even with its analytics off, so the run keeps it on this machine: it sets `MAESTRO_CLI_NO_ANALYTICS=1`, `MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true` and `MAESTRO_DISABLE_UPDATE_CHECK=true`, and points `MAESTRO_API_URL` at a loopback port nothing listens on. To run Maestro by hand (`maestro hierarchy`, a flow under `apps/mobile/build/maestro`), set the same four first, for example `MAESTRO_API_URL=http://127.0.0.1:9`. The run also gives Maestro's runner ten minutes to start on the device (`MAESTRO_DRIVER_STARTUP_TIMEOUT`), which it can need on a loaded machine.
- The OpenClaw CLI, as for the desktop's end-to-end tests.

No Expo account, Apple account, team or signing identity is used.

```bash
pnpm mobile:build   # expo prebuild, pod install and a Release build for the Simulator, into apps/mobile/build
pnpm mobile:check   # the Simulator checks
CLAWTRATE_IOS_SHOTS=/some/folder pnpm mobile:check   # and a screenshot of each screen in light and dark
```

`apps/mobile/ios` is written by `expo prebuild` from `app.json` and is not committed. The build bundles the JavaScript into the app, so no Metro server runs. `pnpm mobile:check` creates a Simulator device of its own ("Clawtrate checks <run>"), boots it without opening the Simulator window, installs the build and starts a development gateway instance of its own (`ios-<run>`); it then drives the app through Maestro and asserts what is on screen. It works over SSH with nobody at the screen. When it ends, also on failure or Ctrl-C, it stops the driver, shuts down and deletes its device and resets its instance, and says so if any of that fails. A subsequent run can clean a recorded device and instance. It knows its device by the identifier it recorded and its instance by its run id, and never touches another Simulator device or instance. A run takes about 45 minutes on a busy machine: the gateway's seeding, a pairing request left to expire, and a ten-minute pause a timestamp check needs. `pnpm lint`, `pnpm typecheck` and `pnpm test` cover the app's code and its unit tests on any platform.
