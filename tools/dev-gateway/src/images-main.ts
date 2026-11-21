// Entry point for the stand-in image provider (scripted-images.ts), started in
// the background by `start --with-images` and recorded as the instance's image
// process.

import { startScriptedImages } from "./scripted-images.ts";

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const port = Number(process.env.SCRIPTED_IMAGES_PORT);
if (!Number.isInteger(port) || port <= 0) {
  console.error("SCRIPTED_IMAGES_PORT is not set");
  process.exit(64);
}
const server = startScriptedImages({ port, log });
server.on("listening", () => console.log(`scripted images listening on 127.0.0.1:${port}`));
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
