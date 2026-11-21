// What OpenClaw 2026.10.6's commands print, recorded from a development
// instance of this checkout (`pnpm dev-gateway start --instance <name>
// --default-local-pairing`) with a temporary home, and cut to the parts the
// look reads. Paths, process ids and the account name are replaced by
// placeholders; the variants below change one recorded fact each.

export const VERSION_LINE = "OpenClaw 2026.10.6 (fe06181)\n";

type StatusOptions = {
  port?: number;
  configExists?: boolean;
  bind?: string;
  /** The running gateway's version, or null when nothing answered. */
  answered?: string | null;
  listening?: boolean;
  service?: "none" | "running" | "stopped" | "unknown";
  label?: string;
  /**
   * The service's `targetRole`. Recorded as `diagnostic-only` on a development
   * instance; a test that needs a service associated with its gateway passes
   * another value.
   */
  targetRole?: string;
  extraServices?: Array<{ label: string }>;
  /** The address the status probed, and the one its RPC answered on. */
  probeUrl?: string;
  rpcUrl?: string;
};

/** `openclaw gateway status --json` (and `--deep`), as recorded, with one fact changed at a time. */
export function statusJson(options: StatusOptions = {}): string {
  const port = options.port ?? 19940;
  const answered = options.answered === undefined ? "2026.10.6" : options.answered;
  const listening = options.listening ?? answered !== null;
  const service = options.service ?? "none";
  const runtime =
    service === "none"
      ? { status: "unknown", missingUnit: true }
      : service === "running"
        ? { status: "running", state: "running", pid: 4242 }
        : service === "stopped"
          ? { status: "stopped" }
          : { status: "unknown" };
  return JSON.stringify({
    cli: { version: "2026.10.6", entrypoint: "<program>/dist/entry.js" },
    logFile: "<tmp>/openclaw/openclaw.log",
    service: {
      label: options.label ?? "LaunchAgent",
      loaded: service === "running",
      loadState: { status: service === "running" ? "loaded" : "not-loaded" },
      loadedText: "loaded",
      notLoadedText: "not loaded",
      targetRole: options.targetRole ?? "diagnostic-only",
      command: null,
      runtime,
      configAudit: { ok: true, issues: [] },
    },
    config: {
      cli: { path: "<state>/openclaw.json", exists: options.configExists ?? true, valid: true },
      daemon: { path: "<state>/openclaw.json", exists: options.configExists ?? true, valid: true },
    },
    gateway: {
      bindMode: options.bind ?? "loopback",
      bindHost: "127.0.0.1",
      port,
      portSource: "env/config",
      probeUrl: options.probeUrl ?? `ws://127.0.0.1:${port}`,
      probeNote: "Loopback-only gateway; only local clients can connect.",
      version: answered,
    },
    hostDesktop: { enabled: false, state: "disabled", port: 5900 },
    port: {
      port,
      status: listening ? "busy" : "free",
      listeners: listening
        ? [
            {
              pid: 4242,
              command: "node",
              address: `127.0.0.1:${port}`,
              commandLine: "openclaw-gateway",
            },
          ]
        : [],
      hints: [],
    },
    rpc:
      answered === null
        ? {
            ok: false,
            kind: "connect",
            capability: "unknown",
            auth: { role: null, scopes: [], capability: "unknown" },
            server: { version: null, connId: null },
            connectFailure: { kind: "unreachable" },
            error: `connect ECONNREFUSED 127.0.0.1:${port}`,
            url: `ws://127.0.0.1:${port}`,
          }
        : {
            ok: true,
            kind: "connect",
            capability: "connected_no_operator_scope",
            auth: { role: "operator", scopes: [], capability: "connected_no_operator_scope" },
            server: { version: answered, buildId: "2026.10.6-release", connId: "conn-1" },
            version: answered,
            url: options.rpcUrl ?? `ws://127.0.0.1:${port}`,
          },
    extraServices: options.extraServices ?? [],
    pluginVersionDrift: { gatewayVersion: answered, drifts: [] },
  });
}

/** `openclaw config get gateway.auth.mode --json`. */
export const authJson = (mode = "token") => `${JSON.stringify(mode)}\n`;

/** `openclaw qr --json --voice-node --url <url>`, with a code the test chooses. */
export function qrJson(url: string, bootstrapToken: string, expiresAtMs: number): string {
  const setupCode = Buffer.from(JSON.stringify({ url, bootstrapToken, expiresAtMs })).toString(
    "base64url",
  );
  return JSON.stringify({
    setupCode,
    gatewayUrl: url,
    auth: "token",
    urlSource: "--url",
    access: "limited",
  });
}
