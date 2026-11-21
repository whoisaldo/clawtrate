// Runs the Node relay: `pnpm --filter @clawtrate/relay start [--port 8788] [--host ::1]
// [--origin wss://relay.example] [--database relay.sqlite]`. It listens on loopback only.

import { parseArgs } from "node:util";
import { startRelayServer } from "./server.ts";

const { values } = parseArgs({
  options: {
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "8788" },
    origin: { type: "string" },
    database: { type: "string" },
  },
});

const server = await startRelayServer({
  host: values.host,
  port: Number(values.port),
  ...(values.origin === undefined ? {} : { origin: values.origin }),
  ...(values.database === undefined ? {} : { database: values.database }),
});
console.log(`Relay listening on ${server.url}, origin ${server.origin}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void server.close().then(() => process.exit(0)));
}
