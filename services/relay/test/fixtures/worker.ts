// The Worker under test: the real Worker and object, with the test's limits, an optional fast
// clock and an optional failing store, all set through vars by `test/support.ts`. One path the
// real Worker does not have, `POST /test/registration-contract`, runs the registration store's
// contract cases in the object, on its own hibernatable sockets and their attachments.

import { DEFAULT_LIMITS, type RelayLimits, type SqlDriver } from "../../src/core/index.ts";
import relay, {
  RelayRoomObject as Base,
  type Env,
  type WorkerClock,
} from "../../src/worker/index.ts";
import { faultySql, warpedClock, type Fault } from "./faults.ts";
import {
  runRegistrationContract,
  type ContractInput,
  type ContractResult,
} from "./registration-contract.ts";

const CONTRACT_PATH = "/test/registration-contract";

export default {
  async fetch(request, env): Promise<Response> {
    if (new URL(request.url).pathname === CONTRACT_PATH && request.method === "POST") {
      const input = (await request.json()) as ContractInput;
      const room = env.RELAY_ROOM.get(env.RELAY_ROOM.idFromName(input.relayId));
      return Response.json(await (room as unknown as RelayRoomObject).registrationContract(input));
    }
    return relay.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;

interface TestEnv extends Env {
  readonly TEST_LIMITS?: string;
  readonly TEST_WARP?: string;
  readonly TEST_EPOCH?: string;
  readonly TEST_FAULT?: string;
}

export class RelayRoomObject extends Base {
  get #env(): TestEnv {
    return this.env as TestEnv;
  }

  protected override roomLimits(): RelayLimits {
    return { ...DEFAULT_LIMITS, ...(JSON.parse(this.#env.TEST_LIMITS ?? "{}") as object) };
  }

  protected override roomClock(): WorkerClock {
    const factor = Number(this.#env.TEST_WARP ?? "1");
    if (factor === 1) return super.roomClock();
    return warpedClock(Number(this.#env.TEST_EPOCH), factor);
  }

  /** Runs the store's contract cases on fresh hibernatable sockets of this object's. */
  async registrationContract(input: ContractInput): Promise<ContractResult[]> {
    const opened: WebSocket[] = [];
    try {
      return await runRegistrationContract(
        {
          socket: () => {
            const server = new WebSocketPair()[1];
            this.ctx.acceptWebSocket(server);
            opened.push(server);
            return this.roomSocket(server);
          },
        },
        input,
      );
    } finally {
      for (const ws of opened) ws.close(1000, "");
    }
  }

  protected override roomSql(): SqlDriver {
    const fault = this.#env.TEST_FAULT as Fault | undefined;
    return fault === undefined ? super.roomSql() : faultySql(super.roomSql(), fault);
  }
}
