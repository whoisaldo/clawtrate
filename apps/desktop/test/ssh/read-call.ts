// What the stand-in `openclaw` of the SSH approval check runs for the two
// reads after an approval, `gateway call gateway.identity.get` and `gateway
// call device.pair.list`, each `--expect-url ws://127.0.0.1:<port> --json`:
// the same command, through the development tool's own guarded runner,
// against the named development instance the check started, and nothing
// else. It prints OpenClaw's answer and exits with its status.
//
//   node read-call.ts <instance> gateway call <method> --expect-url ws://127.0.0.1:<port> --json

import { openInstance } from "../../../../tools/dev-gateway/src/cli.ts";
import { validateInstanceName } from "../../../../tools/dev-gateway/src/instance.ts";

const [name, ...args] = process.argv.slice(2);
const instance = validateInstanceName(name);
if (
  args.length !== 6 ||
  args[0] !== "gateway" ||
  args[1] !== "call" ||
  (args[2] !== "gateway.identity.get" && args[2] !== "device.pair.list") ||
  args[3] !== "--expect-url" ||
  !/^ws:\/\/127\.0\.0\.1:[0-9]{4,5}$/.test(args[4] ?? "") ||
  args[5] !== "--json"
) {
  process.stderr.write("read-call: only the two reads after an approval\n");
  process.exit(2);
}
const result = openInstance(instance).runner.runSync(args);
process.stdout.write(result.stdout);
// Not process.exit: a piped stdout finishes writing the whole document before Node exits.
process.exitCode = result.status ?? 1;
