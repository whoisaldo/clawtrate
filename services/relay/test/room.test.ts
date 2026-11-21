// The room on its own, with sockets and a clock the test controls: what the runtime tests
// cannot set up from outside (addresses, a store that waits, a room rebuilt mid-attempt, the
// queued-bytes cap).

import { DatabaseSync } from "node:sqlite";
import {
  createRegisterProof,
  createSessionId,
  REGISTER_CHALLENGE_MS,
  type RelayToConnector,
} from "@clawtrate/relay-protocol";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMITS,
  RelayRoom,
  RelayStore,
  type ControlState,
  type RelayLimits,
  type RoomSocket,
  type RoomStore,
  type Route,
  type SocketState,
} from "../src/core/index.ts";
import { sqliteDriver } from "../src/node/server.ts";
import { faultySql } from "./fixtures/faults.ts";
import { connectorKey, type ConnectorKey } from "./support.ts";

const ORIGIN = "wss://relay.example.test";

class FakeSocket implements RoomSocket {
  open = true;
  state: SocketState | null = null;
  queued: number | null = null;
  readonly sent: (string | Uint8Array)[] = [];
  closedWith: { code: number; reason: string } | null = null;
  readonly saves: SocketState[] = [];
  /** A save this returns true for throws, as a failing attachment write would. */
  refuse: ((state: SocketState) => boolean) | null = null;

  send(data: string | Uint8Array): void {
    if (!this.open) throw new Error("closed");
    this.sent.push(data);
  }
  close(code: number, reason: string): void {
    this.open = false;
    this.closedWith = { code, reason };
  }
  load() {
    return this.state;
  }
  save(state: SocketState) {
    if (this.refuse?.(state)) throw new Error("Test fault: the write failed.");
    this.state = state;
    this.saves.push(state);
  }
  autoPongAt() {
    return null;
  }
  queuedBytes() {
    return this.queued;
  }
  texts(): Record<string, unknown>[] {
    return this.sent.flatMap((m) => (typeof m === "string" ? [JSON.parse(m)] : []));
  }
  last(): Record<string, unknown> | undefined {
    return this.texts().at(-1);
  }
}

function setup(
  options: { limits?: Partial<RelayLimits>; store?: RoomStore; key?: ConnectorKey } = {},
) {
  const key = options.key ?? connectorKey();
  const sockets: FakeSocket[] = [];
  const clock = { t: 1_000_000, now: () => clock.t, wall: () => Date.now() };
  const store = options.store ?? new RelayStore(sqliteDriver(new DatabaseSync(":memory:")));
  const make = () =>
    new RelayRoom({
      relayId: key.relayId,
      origin: ORIGIN,
      allowLoopbackWs: false,
      limits: { ...DEFAULT_LIMITS, ...options.limits },
      clock,
      store,
      sockets: () => sockets,
    });
  const env = { key, sockets, clock, store, room: make(), rebuild: () => (env.room = make()) };
  const connect = (route: Route, from = "203.0.113.1") => {
    const socket = new FakeSocket();
    sockets.push(socket);
    env.room.connect(socket, route, from);
    return socket;
  };
  return { ...env, env, connect };
}

function proof(key: ConnectorKey, control: FakeSocket): string {
  const challenge = control.texts()[0] as { nonce: string };
  return createRegisterProof({
    secretKey: key.secretKey,
    audience: ORIGIN,
    nonce: challenge.nonce,
    nowMs: Date.now(),
  });
}

async function registered(t: ReturnType<typeof setup>): Promise<FakeSocket> {
  const control = t.connect({ role: "control", relayId: t.key.relayId });
  await t.env.room.message(
    control,
    JSON.stringify({ t: "register", proof: proof(t.key, control) }),
  );
  expect(control.last()).toEqual({ t: "registered" });
  return control;
}

describe("the room", () => {
  it("counts dials per relay id across addresses, and an IPv6 phone by its /64", async () => {
    const t = setup({
      limits: { dialsPerMinute: 4, dialsPerMinutePerAddress: 2, maxSessions: 10 },
    });
    await registered(t);
    const dial = (from: string) => t.connect({ role: "dial", relayId: t.key.relayId }, from);
    expect(dial("2001:db8::1").open).toBe(true);
    expect(dial("2001:db8::2").open).toBe(true);
    // A third from the same /64 is refused, one from the next /64 is not.
    expect(dial("2001:db8::3").last()).toEqual({ t: "error", code: "rate_limited" });
    expect(dial("2001:db8:0:1::1").open).toBe(true);
    // Four dials so far this minute from three addresses; a fifth address is over the relay
    // id's own count.
    expect(dial("203.0.113.9").last()).toEqual({ t: "error", code: "rate_limited" });
  });

  it("saves `verifying` on the socket before asking a store, and ends an attempt that outlives its challenge", async () => {
    const real = new RelayStore(sqliteDriver(new DatabaseSync(":memory:")));
    let release: (fresh: boolean) => void = () => {};
    let stateWhenAsked: string | undefined;
    const t = setup({
      store: {
        hit: (...args) => real.hit(...args),
        claims: real.claims,
        replay: {
          consume: () => {
            stateWhenAsked = (t.sockets[0]!.state as { reg: { state: string } }).reg.state;
            return new Promise<boolean>((resolve) => (release = resolve));
          },
        },
      },
    });
    const control = t.connect({ role: "control", relayId: t.key.relayId });
    const attempt = t.env.room.message(
      control,
      JSON.stringify({ t: "register", proof: proof(t.key, control) }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(stateWhenAsked).toBe("verifying");
    t.clock.t += REGISTER_CHALLENGE_MS + 1;
    t.env.room.alarm();
    expect(control.last()).toEqual({ t: "error", code: "idle_timeout" });
    release(true);
    await attempt;
    expect(control.texts().some((m) => m.t === "registered")).toBe(false);
    expect(real.pinnedKey(t.key.relayId)).toBeNull();
    // The success was never stored, not even for a moment.
    expect(control.saves.map((saved) => (saved as ControlState).reg.state)).not.toContain(
      "registered",
    );
  });

  it("does not resume a registration that hibernation cut off", async () => {
    const t = setup();
    const control = t.connect({ role: "control", relayId: t.key.relayId });
    // The object went away while the attempt waited on a store: the socket's latest state.
    const state = control.state as ControlState;
    control.state = { ...state, reg: { ...state.reg, state: "verifying" } };
    t.rebuild();
    expect(t.env.room.nextDeadline()).toBe(state.reg.issuedAtMs + REGISTER_CHALLENGE_MS + 1);
    t.env.room.alarm();
    expect(control.last()).toEqual({ t: "error", code: "internal" });
  });

  it("carries on in a room rebuilt over the same sockets, as after hibernation", async () => {
    const t = setup();
    const control = t.connect({ role: "control", relayId: t.key.relayId });
    t.rebuild();
    await t.env.room.message(
      control,
      JSON.stringify({ t: "register", proof: proof(t.key, control) }),
    );
    expect(control.last()).toEqual({ t: "registered" });
    t.rebuild();
    const phone = t.connect({ role: "dial", relayId: t.key.relayId });
    const dial = control.last() as RelayToConnector & { t: "dial" };
    expect(dial).toMatchObject({ t: "dial", from: "203.0.113.1" });
    t.rebuild();
    const session = t.connect({ role: "session", relayId: t.key.relayId, session: dial.session });
    expect(phone.last()).toEqual({ t: "open" });
    t.rebuild();
    await t.env.room.message(phone, new Uint8Array([1, 3, 9]));
    expect(session.sent.at(-1)).toEqual(new Uint8Array([1, 3, 9]));
  });

  it("sets its next deadline from every socket's own", async () => {
    const t = setup({ limits: { dialTimeoutMs: 15_000, idleMs: 120_000 } });
    expect(t.env.room.nextDeadline()).toBeNull();
    const start = t.clock.t;
    const control = await registered(t);
    expect(t.env.room.nextDeadline()).toBe(start + 120_001);
    t.clock.t += 1_000;
    t.connect({ role: "dial", relayId: t.key.relayId });
    expect(t.env.room.nextDeadline()).toBe(start + 1_000 + 15_001);
    t.clock.t += 15_001;
    t.env.room.alarm();
    expect(t.env.room.nextDeadline()).toBe(start + 120_001);
    control.close(1000, "");
    expect(t.env.room.nextDeadline()).toBeNull();
  });

  it("closes a session whose peer has too much waiting to be written", async () => {
    const t = setup({ limits: { maxQueuedBytes: 100 } });
    const control = await registered(t);
    const phone = t.connect({ role: "dial", relayId: t.key.relayId });
    const { session: id } = control.last() as { session: string };
    const session = t.connect({ role: "session", relayId: t.key.relayId, session: id });
    session.queued = 60;
    await t.env.room.message(phone, new Uint8Array(40));
    expect(session.sent.at(-1)).toEqual(new Uint8Array(40));
    await t.env.room.message(phone, new Uint8Array(41));
    expect(phone.last()).toEqual({ t: "error", code: "rate_limited" });
    expect(session.last()).toEqual({ t: "error", code: "rate_limited" });
  });

  it("fails a registration whose store fails, and pins nothing", async () => {
    const driver = sqliteDriver(new DatabaseSync(":memory:"));
    const t = setup({ store: new RelayStore(faultySql(driver, "replay")) });
    const control = t.connect({ role: "control", relayId: t.key.relayId });
    await t.env.room.message(
      control,
      JSON.stringify({ t: "register", proof: proof(t.key, control) }),
    );
    expect(control.last()).toEqual({ t: "error", code: "internal" });
    expect(control.closedWith).toEqual({ code: 1011, reason: "internal" });
    expect(driver.all("SELECT COUNT(*) AS n FROM relay_pins")).toEqual([{ n: 0 }]);
  });

  it("closes and discards a socket whose success or failure could not be stored", async () => {
    const regState = (state: SocketState) => (state as ControlState).reg.state;
    // The commit's write fails, so its outcome is unknown; then a bad proof's failure write.
    for (const [refused, bad] of [
      ["registered", false],
      ["failed", true],
    ] as const) {
      const t = setup();
      const control = t.connect({ role: "control", relayId: t.key.relayId });
      control.refuse = (state) => regState(state) === refused;
      const other = connectorKey();
      await t.env.room.message(
        control,
        JSON.stringify({ t: "register", proof: proof(bad ? other : t.key, control) }),
      );
      expect(control.last(), refused).toEqual({ t: "error", code: "internal" });
      expect(control.closedWith, refused).toEqual({ code: 1011, reason: "internal" });
      // A room rebuilt over the same sockets, as after hibernation, has no connector.
      t.rebuild();
      const phone = t.connect({ role: "dial", relayId: t.key.relayId });
      expect(phone.last(), refused).toEqual({ t: "error", code: "connector_offline" });
    }
  });

  it("acts on nothing from a socket it closed, so a discarded challenge cannot register", async () => {
    const store = new RelayStore(sqliteDriver(new DatabaseSync(":memory:")));
    const t = setup({ store });
    const control = t.connect({ role: "control", relayId: t.key.relayId });
    const late = proof(t.key, control);
    // The timer sees the clock go back and ends the idle challenge: the room closes the socket,
    // and nothing is stored for it.
    t.clock.t -= 1;
    t.env.room.alarm();
    expect(control.closedWith).toEqual({ code: 1000, reason: "idle_timeout" });
    expect((control.state as ControlState).reg.state).toBe("challenged");
    // The clock recovers, and a proof arrives while the close finishes, in a room rebuilt as
    // after hibernation.
    t.clock.t += 1;
    t.rebuild();
    await t.env.room.message(control, JSON.stringify({ t: "register", proof: late }));
    expect(control.saves.map((saved) => (saved as ControlState).reg.state)).not.toContain(
      "registered",
    );
    expect(store.pinnedKey(t.key.relayId)).toBeNull();
  });

  it("refuses a session socket for a session id it never gave out", () => {
    const t = setup();
    const session = t.connect({
      role: "session",
      relayId: t.key.relayId,
      session: createSessionId(),
    });
    expect(session.last()).toEqual({ t: "error", code: "peer_gone" });
  });
});
