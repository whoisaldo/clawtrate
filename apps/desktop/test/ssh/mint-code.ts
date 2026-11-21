// What the stand-in `openclaw` of the gateway end-to-end check runs for
// `qr --json --voice-node --url ws://127.0.0.1:<port>`: the same command,
// through the development tool's own guarded runner, against the named
// development instance the check started, and nothing else. It prints
// OpenClaw's answer and exits with its status.
//
//   node mint-code.ts <instance> qr --json --voice-node --url ws://127.0.0.1:<port>

import { openInstance } from "../../../../tools/dev-gateway/src/cli.ts";
import { validateInstanceName } from "../../../../tools/dev-gateway/src/instance.ts";

const [name, ...args] = process.argv.slice(2);
const instance = validateInstanceName(name);
const url = args[4] ?? "";
if (
  args.length !== 5 ||
  args.slice(0, 4).join(" ") !== "qr --json --voice-node --url" ||
  !/^ws:\/\/127\.0\.0\.1:[0-9]{4,5}$/.test(url)
) {
  process.stderr.write("mint-code: only the CODE script's command\n");
  process.exit(2);
}
const result = openInstance(instance).runner.runSync([
  "qr",
  "--json",
  "--voice-node",
  "--url",
  url,
]);
process.stdout.write(result.stdout);
process.exit(result.status ?? 1);
