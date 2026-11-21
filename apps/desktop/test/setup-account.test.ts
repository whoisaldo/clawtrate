// The account's home comes from the account record, never from the launch's
// HOME: a launch that sets HOME elsewhere doesn't move what setup treats as the
// account's home.
import type * as Os from "node:os";
import { expect, it, vi } from "vitest";

vi.mock("node:os", async (load) => ({
  ...(await load<typeof Os>()),
  userInfo: () => ({ homedir: "/fixture/account" }),
}));

const { accountHome } = await import("../src/setup/world.ts");

it("S3: the default account lookup ignores the launch HOME", () => {
  vi.stubEnv("HOME", "/fixture/elsewhere");
  try {
    expect(accountHome()).toBe("/fixture/account");
  } finally {
    vi.unstubAllEnvs();
  }
});
