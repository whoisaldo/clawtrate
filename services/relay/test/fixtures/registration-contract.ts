// The protocol's `RegistrationStore` contract, as cases that run against the relay's store over
// a host's real socket: the Node runner's `NodeSocket`, and in workerd the Durable Object's
// hibernatable WebSocket and its attachment (`worker.ts` runs them there). Plain code with no
// test runner, so the same cases run in both. They port the cases `packages/relay-protocol`
// runs against `MemoryRegistrationStore` (`register-proof.test.ts`), with its synchronous commit.

import {
  ControlRegistration,
  createRegisterProof,
  decodeRelayToConnector,
  fromBase64Url,
  MemoryKeyClaims,
  MemoryReplayStore,
  REGISTER_CHALLENGE_MS,
  type KeyClaims,
  type RegisterProofResult,
  type RegistrationSnapshot,
  type RegistrationStore,
  type ReplayStore,
} from "@clawtrate/relay-protocol";
import {
  SocketRegistrationStore,
  type ControlState,
  type RoomSocket,
  type SocketState,
} from "../../src/core/index.ts";

export interface ContractHost {
  /** A fresh, open socket of the host's kind, with no state yet. */
  socket(): RoomSocket;
}

export interface ContractInput {
  readonly relayId: string;
  /** The connector's Ed25519 secret key, base64url. */
  readonly secretKey: string;
}

export interface ContractResult {
  readonly name: string;
  /** Null when the case held, or what went wrong. */
  readonly error: string | null;
}

const ORIGIN = "wss://relay.example.test";
const CONTROL_ID = "control";
const START = 5_000;

interface Context {
  readonly host: ContractHost;
  readonly relayId: string;
  readonly secretKey: Uint8Array;
}

/** A host socket that records the registration state of each save, as read back from it. */
function recorded(socket: RoomSocket) {
  const states: string[] = [];
  const wrapped: RoomSocket = {
    get open() {
      return socket.open;
    },
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    load: () => socket.load(),
    save: (state) => {
      socket.save(state);
      const saved = socket.load();
      states.push(saved?.role === "control" ? saved.reg.state : "?");
    },
    autoPongAt: () => socket.autoPongAt(),
    queuedBytes: () => socket.queuedBytes(),
  };
  return { socket: wrapped, states };
}

function reg(socket: RoomSocket): RegistrationSnapshot {
  const state = socket.load();
  if (state?.role !== "control") throw new Error("The socket holds no control state.");
  return state.reg;
}

/** A claim that waits for `release` before it decides, as a slow store would. */
function waitingClaims() {
  const claims = new MemoryKeyClaims();
  let release = (): void => {};
  let asked = false;
  const held = new Promise<void>((resolve) => (release = resolve));
  const waiting: KeyClaims = {
    claim: async (relayId, key, attempt) => {
      asked = true;
      await held;
      return claims.claim(relayId, key, attempt);
    },
  };
  return { claims: waiting, release: () => release(), asked: () => asked };
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 0));
  check(done(), "the attempt never reached the step");
}

/** A control socket of the host's, its store, and its registration. */
function control(
  context: Context,
  options: {
    clock?: () => number;
    claims?: KeyClaims;
    replay?: ReplayStore;
    restore?: RegistrationSnapshot;
    wrap?: (store: RegistrationStore) => RegistrationStore;
  } = {},
) {
  const { socket, states } = recorded(context.host.socket());
  const store = new SocketRegistrationStore(socket, CONTROL_ID);
  const make = (restore?: RegistrationSnapshot) =>
    new ControlRegistration({
      relayId: context.relayId,
      origin: ORIGIN,
      clock: options.clock ?? (() => START),
      wallClock: () => Date.now(),
      replay: options.replay ?? new MemoryReplayStore(),
      claims: options.claims ?? new MemoryKeyClaims(),
      store: options.wrap ? options.wrap(store) : store,
      ...(restore === undefined ? {} : { restore }),
    });
  const registration = make(options.restore);
  const first: ControlState = {
    role: "control",
    id: CONTROL_ID,
    reg: registration.snapshot(),
    seenAt: 0,
  };
  socket.save(first);
  states.length = 0;
  const register = (): Promise<RegisterProofResult> => {
    const challenge = decodeRelayToConnector(registration.challengeMessage);
    if (challenge.t !== "challenge") throw new Error("No challenge.");
    const proof = createRegisterProof({
      secretKey: context.secretKey,
      audience: ORIGIN,
      nonce: challenge.nonce,
      nowMs: Date.now(),
    });
    return registration.register(proof);
  };
  /** The registration a room rebuilt after hibernation would make from the socket. */
  const restored = () => make(reg(socket));
  return { socket, store, states, registration, register, restored };
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function same(actual: unknown, expected: unknown, what: string): void {
  const [a, b] = [JSON.stringify(actual), JSON.stringify(expected)];
  check(a === b, `${what}: expected ${b}, got ${a}`);
}

function throws(run: () => unknown, what: string): void {
  let threw = false;
  try {
    run();
  } catch {
    threw = true;
  }
  check(threw, `${what} did not throw`);
}

const CASES: readonly (readonly [string, (context: Context) => Promise<void> | void])[] = [
  [
    "takes a success only through a commit that finds the attempt live",
    (context) => {
      const { socket, store, registration } = control(context);
      const snapshot = registration.snapshot();
      const registered = { ...snapshot, state: "registered" as const };
      throws(() => store.persist(registered), "persisting a success");
      throws(() => store.commitRegistered(snapshot, { live: true }), "committing a challenge");
      same(store.commitRegistered(registered, { live: false }), "cancelled", "a dead attempt");
      same(reg(socket), snapshot, "the socket after a cancelled commit");
      same(store.commitRegistered(registered, { live: true }), "committed", "a live attempt");
      same(reg(socket), registered, "the socket after the commit");
      store.persist({ ...snapshot, state: "failed" });
      same(reg(socket).state, "failed", "the socket after a later failure");
    },
  ],
  [
    "copies and checks the snapshot before it reads whether the attempt is live",
    (context) => {
      const { socket, store, registration } = control(context);
      const snapshot = registration.snapshot();
      const read: string[] = [];
      let state = "registered";
      const tricky = {
        get nonce() {
          read.push("nonce");
          return snapshot.nonce;
        },
        get issuedAtMs() {
          read.push("issuedAtMs");
          return snapshot.issuedAtMs;
        },
        get lastReadingMs() {
          read.push("lastReadingMs");
          return snapshot.lastReadingMs;
        },
        get state() {
          read.push("state");
          return state;
        },
      } as RegistrationSnapshot;
      const attempt = {
        get live() {
          read.push("live");
          // A getter that changes the snapshot after its copy changes nothing stored.
          state = "challenged";
          return true;
        },
      };
      same(store.commitRegistered(tricky, attempt), "committed", "the commit");
      same(read, ["nonce", "issuedAtMs", "lastReadingMs", "state", "live"], "the reads");
      same(reg(socket), { ...snapshot, state: "registered" }, "the stored success");
      const success = { ...snapshot, state: "registered" };
      for (const bad of [
        { ...snapshot, state: "prepared" },
        { ...success, lastReadingMs: Number.NaN },
        { ...success, issuedAtMs: -1 },
        { ...success, issuedAtMs: 1.5 },
        { ...success, lastReadingMs: snapshot.issuedAtMs - 1 },
        { ...success, nonce: 7 },
        { ...success, nonce: snapshot.nonce.slice(1) },
        { ...success, nonce: `${snapshot.nonce}=` },
      ]) {
        read.length = 0;
        throws(
          () => store.commitRegistered(bad as unknown as RegistrationSnapshot, attempt),
          `committing ${JSON.stringify(bad)}`,
        );
        same(read, [], "the attempt read for a refused snapshot");
        const failed = { ...bad, state: bad.state === "prepared" ? "prepared" : "failed" };
        throws(
          () => store.persist(failed as unknown as RegistrationSnapshot),
          `persisting ${JSON.stringify(failed)}`,
        );
      }
      same(reg(socket), { ...snapshot, state: "registered" }, "the socket after refusals");
    },
  ],
  [
    "refuses to write for a socket that no longer holds the registration",
    (context) => {
      const { socket, store, registration } = control(context);
      const snapshot = registration.snapshot();
      const current = socket.load() as ControlState;
      const others: SocketState[] = [
        { ...current, id: "another" },
        { role: "session", id: CONTROL_ID, session: "s", seenAt: 0, bytes: 0 },
      ];
      for (const other of others) {
        socket.save(other);
        let read = false;
        const attempt = {
          get live() {
            read = true;
            return true;
          },
        };
        throws(() => store.persist(snapshot), "persisting for another socket");
        throws(
          () => store.commitRegistered({ ...snapshot, state: "registered" }, attempt),
          "committing for another socket",
        );
        check(!read, "the commit read the attempt for another socket");
        same(socket.load(), other, "the other socket's state");
      }
    },
  ],
  [
    "stores verifying before any store is asked, and keeps it while the success is prepared",
    async (context) => {
      const waiting = waitingClaims();
      const replay = new MemoryReplayStore();
      let whenAsked: string | null = null;
      const c = control(context, {
        claims: waiting.claims,
        replay: {
          consume: (input) => {
            whenAsked = reg(c.socket).state;
            return replay.consume(input);
          },
        },
      });
      const pending = c.register();
      await until(waiting.asked);
      same(whenAsked, "verifying", "the state when the replay store was asked");
      same(reg(c.socket).state, "verifying", "the state while the success is prepared");
      same(c.restored().state, "failed", "a restore while the success is prepared");
      waiting.release();
      same((await pending).ok, true, "the registration");
      same(c.states, ["verifying", "registered"], "the states stored");
    },
  ],
  [
    "an abort while the success is prepared cancels it and stores the failure",
    async (context) => {
      const waiting = waitingClaims();
      const c = control(context, { claims: waiting.claims });
      const pending = c.register();
      await until(waiting.asked);
      c.registration.abort();
      waiting.release();
      same(await pending, { ok: false, code: "aborted" }, "the result");
      same(c.states, ["verifying", "failed"], "the states stored");
      same(c.restored().state, "failed", "the restore");
    },
  ],
  [
    "the timer's expiry while the success is prepared reports the clock failure it saw",
    async (context) => {
      for (const [label, timerReading, code] of [
        ["rollback, then recovery", START - 1, "bad_clock"],
        ["elapsed deadline", START + REGISTER_CHALLENGE_MS + 1, "challenge_expired"],
        ["plain abort", null, "aborted"],
      ] as const) {
        let now = START;
        const waiting = waitingClaims();
        const c = control(context, { clock: () => now, claims: waiting.claims });
        const pending = c.register();
        await until(waiting.asked);
        if (timerReading === null) {
          c.registration.abort();
        } else {
          now = timerReading;
          same(c.registration.expire(), true, `${label}: the expiry`);
          // The clock comes back in time; the cause the timer saw stays.
          now = START;
        }
        waiting.release();
        same(await pending, { ok: false, code }, `${label}: the result`);
        same(c.states, ["verifying", "failed"], `${label}: the states stored`);
        same(c.restored().state, "failed", `${label}: the restore`);
      }
    },
  ],
  [
    "an expiry while the success is prepared cancels it and stores the failure",
    async (context) => {
      let now = START;
      const waiting = waitingClaims();
      const c = control(context, { clock: () => now, claims: waiting.claims });
      const pending = c.register();
      await until(waiting.asked);
      now = START + REGISTER_CHALLENGE_MS + 1;
      waiting.release();
      same(await pending, { ok: false, code: "challenge_expired" }, "the result");
      same(c.states, ["verifying", "failed"], "the states stored");
      same(c.restored().state, "failed", "the restore");
    },
  ],
  [
    "an abort from the commit's own reading of the attempt cancels it",
    async (context) => {
      let inCommit = false;
      let outcome: string | null = null;
      const c = control(context, {
        clock: () => {
          if (inCommit) c.registration.abort();
          return START;
        },
        wrap: (store) => ({
          persist: (snapshot) => store.persist(snapshot),
          commitRegistered: (snapshot, attempt) => {
            inCommit = true;
            try {
              const result = store.commitRegistered(snapshot, attempt);
              outcome = result as string;
              return result;
            } finally {
              inCommit = false;
            }
          },
        }),
      });
      same(await c.register(), { ok: false, code: "aborted" }, "the result");
      same(outcome, "cancelled", "the commit");
      same(c.states, ["verifying", "failed"], "the states stored");
    },
  ],
  [
    "an expiry at the commit's own reading of the attempt cancels it",
    async (context) => {
      let now = START;
      let inCommit = false;
      const c = control(context, {
        clock: () => (inCommit ? START + REGISTER_CHALLENGE_MS + 1 : now),
        wrap: (store) => ({
          persist: (snapshot) => store.persist(snapshot),
          commitRegistered: (snapshot, attempt) => {
            inCommit = true;
            try {
              return store.commitRegistered(snapshot, attempt);
            } finally {
              inCommit = false;
              now = START + REGISTER_CHALLENGE_MS + 1;
            }
          },
        }),
      });
      same(await c.register(), { ok: false, code: "challenge_expired" }, "the result");
      same(c.states, ["verifying", "failed"], "the states stored");
    },
  ],
  [
    "an uninterrupted success is committed once and restores as registered, with its clock",
    async (context) => {
      const c = control(context);
      same((await c.register()).ok, true, "the registration");
      same(c.registration.state, "registered", "the registration's state");
      same(c.states, ["verifying", "registered"], "the states stored");
      const restored = c.restored();
      same(restored.state, "registered", "the restore");
      same(restored.snapshot().lastReadingMs, START, "the restored clock reading");
      // An end after completion is teardown: the committed success stays as it is.
      c.registration.abort();
      same(c.registration.state, "registered", "the state after a later abort");
      same(reg(c.socket).state, "registered", "the stored state after a later abort");
    },
  ],
  [
    "an expiry or a socket end after completion changes nothing",
    async (context) => {
      let now = START;
      const c = control(context, { clock: () => now });
      same((await c.register()).ok, true, "the registration");
      now = START + REGISTER_CHALLENGE_MS + 1;
      same(c.registration.expire(), false, "the late expiry");
      c.registration.abort();
      same(c.registration.state, "registered", "the registration's state");
      same(c.states, ["verifying", "registered"], "the states stored");
      same(c.restored().state, "registered", "the restore");
    },
  ],
  [
    "completes in the same turn as the commit: an abort queued from it is teardown",
    async (context) => {
      let inCommit = false;
      let stateAtAbort: string | null = null;
      const c = control(context, {
        clock: () => {
          if (inCommit) {
            inCommit = false;
            queueMicrotask(() => {
              c.registration.abort();
              stateAtAbort = c.registration.state;
            });
          }
          return START;
        },
        wrap: (store) => ({
          persist: (snapshot) => store.persist(snapshot),
          commitRegistered: (snapshot, attempt) => {
            inCommit = true;
            return store.commitRegistered(snapshot, attempt);
          },
        }),
      });
      same((await c.register()).ok, true, "the registration");
      same(stateAtAbort, "registered", "the state when the queued abort ran");
      same(c.registration.state, "registered", "the registration's state");
      same(c.states, ["verifying", "registered"], "the states stored");
      same(c.restored().state, "registered", "the restore");
    },
  ],
  [
    "a failure that cannot be stored is store_failed, and leaves no success to restore",
    async (context) => {
      const waiting = waitingClaims();
      const c = control(context, { claims: waiting.claims });
      const pending = c.register();
      await until(waiting.asked);
      c.registration.abort();
      // The socket no longer holds the registration, so the write of `failed` is refused.
      const current = c.socket.load() as ControlState;
      c.socket.save({ ...current, id: "another" });
      waiting.release();
      same(await pending, { ok: false, code: "store_failed" }, "the result");
      same(c.registration.state, "failed", "the registration's state");
      same(reg(c.socket).state, "verifying", "the state left on the socket");
      same(c.restored().state, "failed", "the restore");
    },
  ],
  [
    "keeps the last clock reading, so a restore refuses a lower one",
    async (context) => {
      let now = START;
      const c = control(context, { clock: () => now });
      now = START + 50_000;
      same(c.registration.expire(), false, "the expiry in time");
      c.store.persist(c.registration.snapshot());
      same(reg(c.socket).lastReadingMs, START + 50_000, "the stored reading");
      now = START + 5_000;
      const restored = c.restored();
      same(restored.state, "challenged", "the restore");
      const challenge = decodeRelayToConnector(restored.challengeMessage);
      if (challenge.t !== "challenge") throw new Error("No challenge.");
      const proof = createRegisterProof({
        secretKey: context.secretKey,
        audience: ORIGIN,
        nonce: challenge.nonce,
        nowMs: Date.now(),
      });
      same(await restored.register(proof), { ok: false, code: "bad_clock" }, "the result");
    },
  ],
  [
    "fails with store_failed when the socket no longer holds the registration, storing no success",
    async (context) => {
      const waiting = waitingClaims();
      const c = control(context, { claims: waiting.claims });
      const pending = c.register();
      await until(waiting.asked);
      const current = c.socket.load() as ControlState;
      c.socket.save({ ...current, id: "another" });
      waiting.release();
      same(await pending, { ok: false, code: "store_failed" }, "the result");
      same(c.registration.state, "failed", "the registration's state");
      same(reg(c.socket).state, "verifying", "the state left on the socket");
    },
  ],
];

export const CONTRACT_CASES: readonly string[] = CASES.map(([name]) => name);

export async function runRegistrationContract(
  host: ContractHost,
  input: ContractInput,
): Promise<ContractResult[]> {
  const secretKey = fromBase64Url(input.secretKey);
  if (secretKey === null) throw new Error("The secret key is not base64url.");
  const context: Context = { host, relayId: input.relayId, secretKey };
  const results: ContractResult[] = [];
  for (const [name, run] of CASES) {
    try {
      await run(context);
      results.push({ name, error: null });
    } catch (error) {
      results.push({ name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
