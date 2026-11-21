// The web host's `--setup-look` (docs/development/setup.md): the first screen
// of setup, looking on the computer that runs the host. It is a development
// and review aid, so it looks only in the sandbox `--setup-sandbox` names,
// keeps its data in that run's own folder, and never resumes a saved gateway.
// It never pairs: this host has no dialog of its own to ask first.

import { validateSandbox, type SandboxContext, type ValidatedSandbox } from "../setup/sandbox.ts";
import { SetupRefusedError } from "../setup/world.ts";

export type SetupLookChoice =
  | { kind: "off" }
  | { kind: "sandbox"; file: string; sandbox: ValidatedSandbox; dataDir: string }
  | { kind: "refused"; message: string };

export function setupLookChoice(
  values: { "setup-look"?: boolean; "setup-sandbox"?: string; "data-dir"?: string },
  context: SandboxContext,
): SetupLookChoice {
  if (!values["setup-look"]) return { kind: "off" };
  const file = values["setup-sandbox"] ?? "";
  if (file === "") return { kind: "refused", message: new SetupRefusedError("missing").message };
  if (values["data-dir"] !== undefined)
    return {
      kind: "refused",
      message: "--setup-look keeps its data in its sandbox's run folder: leave out --data-dir.",
    };
  try {
    const sandbox = validateSandbox(file, context);
    return { kind: "sandbox", file, sandbox, dataDir: sandbox.appData };
  } catch (error) {
    const refusal = error instanceof SetupRefusedError ? error : new SetupRefusedError("file");
    return { kind: "refused", message: refusal.message };
  }
}
