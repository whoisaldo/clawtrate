// What `ssh` wrote to its error output, read in memory and reduced to a
// category (docs/research/setup-flow.md, section 7). No line of it is kept or
// shown: only the category, the one cause in brackets, and the exit status.

export type UnreachableCause =
  "connection refused" | "no such name" | "timed out" | "network unreachable";

export type SshFailure =
  | { kind: "unreachable"; cause: UnreachableCause; exit: number }
  | { kind: "sign-in-refused"; exit: number }
  | { kind: "host-key-unknown"; exit: number }
  | { kind: "host-key-changed"; exit: number }
  | { kind: "dropped"; exit: number }
  | { kind: "local-port-taken"; exit: number }
  | { kind: "timed-out" }
  /** `ssh` could not be started: the program or the system refused it. */
  | { kind: "spawn-failed" }
  | { kind: "ssh-stopped"; exit: number | null };

/** The facts a line of `ssh`'s error output can carry, as bits. */
const FACT = {
  keyChanged: 1,
  keyFailed: 2,
  denied: 4,
  portTaken: 8,
  noName: 16,
  refused: 32,
  closed: 64,
  network: 128,
  dropped: 256,
  timedOut: 512,
} as const;

/**
 * The facts of one line. `-v`'s debug lines and a running forward's
 * per-connection channel lines say nothing about why `ssh` itself stopped.
 */
export function lineFacts(raw: string): number {
  const line = raw.replace(/\r$/, "");
  if (/^debug[0-9]: |^channel [0-9]+: /.test(line)) return 0;
  let facts = 0;
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/.test(line)) facts |= FACT.keyChanged;
  if (/Host key verification failed\./.test(line)) facts |= FACT.keyFailed;
  if (/Permission denied \(/.test(line)) facts |= FACT.denied;
  if (/Address already in use|Could not request local forwarding/.test(line))
    facts |= FACT.portTaken;
  if (/Could not resolve hostname/.test(line)) facts |= FACT.noName;
  if (/Connection refused/.test(line)) facts |= FACT.refused;
  if (/closed by remote host/.test(line)) facts |= FACT.closed;
  if (/Network is unreachable|No route to host/.test(line)) facts |= FACT.network;
  if (
    /closed by remote host|Timeout, server .* not responding|Connection reset|Broken pipe/.test(
      line,
    )
  ) {
    facts |= FACT.dropped;
  }
  if (/(Operation|Connection) timed out|timed out during banner exchange/.test(line))
    facts |= FACT.timedOut;
  return facts;
}

/** The category of an `ssh` that exited with `exit`, from the facts of its error output's lines. */
export function failureFromFacts(facts: number, exit: number | null): SshFailure {
  if (exit !== 255) return { kind: "ssh-stopped", exit };
  if (facts & FACT.keyChanged) return { kind: "host-key-changed", exit };
  if (facts & FACT.keyFailed) return { kind: "host-key-unknown", exit };
  if (facts & FACT.denied) return { kind: "sign-in-refused", exit };
  if (facts & FACT.portTaken) return { kind: "local-port-taken", exit };
  if (facts & FACT.noName) return { kind: "unreachable", cause: "no such name", exit };
  if (facts & FACT.refused && !(facts & FACT.closed)) {
    return { kind: "unreachable", cause: "connection refused", exit };
  }
  if (facts & FACT.network) return { kind: "unreachable", cause: "network unreachable", exit };
  if (facts & FACT.dropped) return { kind: "dropped", exit };
  if (facts & FACT.timedOut) return { kind: "unreachable", cause: "timed out", exit };
  return { kind: "ssh-stopped", exit };
}

/** The category of an `ssh` that exited with `exit` after writing `stderr`. */
export function classifySshFailure(stderr: string, exit: number | null): SshFailure {
  return failureFromFacts(
    stderr.split("\n").reduce((facts, line) => facts | lineFacts(line), 0),
    exit,
  );
}

/** The longest part of a line a forward's reader holds while it waits for the line's end. */
export const MAX_PENDING_LINE = 1024;

/**
 * A running forward's error output, read as it arrives into facts only: why
 * it may stop, whether it listens, and what its forwarded connections met.
 * No line is kept once read, and an unfinished line is held to
 * `MAX_PENDING_LINE` characters.
 */
export class ForwardOutput {
  facts = 0;
  listening = false;
  refused = false;
  connectFailed = false;
  private pending = "";
  private overlong = false;
  private readonly local: number | string;

  /** `local` is the forward's local port, or the path of its local socket. */
  constructor(local: number | string) {
    this.local = local;
  }

  get held(): number {
    return this.pending.length;
  }

  push(chunk: string): void {
    const parts = chunk.split("\n");
    const last = parts.pop() ?? "";
    for (const part of parts) {
      const line =
        this.overlong || this.pending.length + part.length > MAX_PENDING_LINE
          ? ""
          : this.pending + part;
      this.pending = "";
      this.overlong = false;
      this.read(line);
    }
    if (this.overlong) return;
    this.pending += last;
    if (this.pending.length > MAX_PENDING_LINE) {
      // A line this long is no line ssh writes about these facts: drop it to its end.
      this.pending = "";
      this.overlong = true;
    }
  }

  private read(line: string): void {
    this.facts |= lineFacts(line);
    const plain = line.replace(/\r$/, "");
    if (forwardListening(plain, this.local)) this.listening = true;
    if (/^channel [0-9]+: open failed: administratively prohibited/.test(plain))
      this.refused = true;
    if (/^channel [0-9]+: open failed: connect failed/.test(plain)) this.connectFailed = true;
  }
}

/** The `-v` lines a host-key probe reads, and nothing else. */
export type ProbeLines = {
  /** `debug1: Server host key: <type> SHA256:<fingerprint>` */
  serverKey: { type: string; fingerprint: string } | null;
  /** `debug1: Host '…' is known and matches the … host key.` */
  matches: boolean;
  /** `debug1: Found key in <file>:<line>` */
  foundIn: { file: string; line: number } | null;
};

export function readProbeLines(stderr: string): ProbeLines {
  const result: ProbeLines = { serverKey: null, matches: false, foundIn: null };
  for (const raw of stderr.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const server = /^debug1: Server host key: ([a-z0-9@.-]{1,64}) (SHA256:[A-Za-z0-9+/]{43})$/.exec(
      line,
    );
    if (server && !result.serverKey) {
      result.serverKey = { type: server[1]!, fingerprint: server[2]! };
      continue;
    }
    if (
      /^debug1: Host '[^']{1,300}' is known and matches the [A-Z0-9-]{1,32} host key\.$/.test(line)
    ) {
      result.matches = true;
      continue;
    }
    const found = /^debug1: Found key in (.{1,4096}):([0-9]{1,9})$/.exec(line);
    if (found && !result.foundIn) result.foundIn = { file: found[1]!, line: Number(found[2]) };
  }
  return result;
}

/** `debug1: Local forwarding listening on 127.0.0.1 port <n>.` */
export function forwardListening(line: string, local: number | string): boolean {
  const plain = line.replace(/\r$/, "");
  return typeof local === "number"
    ? plain === `debug1: Local forwarding listening on 127.0.0.1 port ${local}.`
    : plain === `debug1: Local forwarding listening on path ${local}.`;
}

/** The version `ssh -V` reports, for the clients the research ran. */
export type SshVersion = { windows: boolean; major: number; minor: number };

export function parseSshVersion(text: string): SshVersion | null {
  const match = /^OpenSSH_(for_Windows_)?([0-9]{1,2})\.([0-9]{1,2})/m.exec(text);
  if (!match) return null;
  return { windows: Boolean(match[1]), major: Number(match[2]), minor: Number(match[3]) };
}
