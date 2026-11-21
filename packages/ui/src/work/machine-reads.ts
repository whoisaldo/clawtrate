// The Computer tab's machine reads, in order: "Check again" (manual) and the read made when the
// tab is shown or its nodes change (automatic). Only the newest read's answer or failure is kept,
// and "Checking…" shows only while the manual read it belongs to is the newest one still out.

export type MachineReadEvents<T> = {
  /** The newest read answered. */
  keep(answer: T, manual: boolean): void;
  /** The newest read failed as a whole. */
  fail(): void;
  /** Whether "Checking…" shows. */
  checking(on: boolean): void;
};

export type MachineReader<T> = {
  /** Start a read; a read still out is superseded by it. */
  read(ask: () => Promise<T>, manual: boolean): void;
  /** What was read is no longer asked for (the nodes, the task or the connection changed). */
  invalidate(): void;
};

export function machineReader<T>(events: MachineReadEvents<T>): MachineReader<T> {
  /** The newest read's number. */
  let current = 0;
  /** The manual read "Checking…" belongs to, while it is out. */
  let checkingFor: number | null = null;
  const stopChecking = () => {
    if (checkingFor === null) return;
    checkingFor = null;
    events.checking(false);
  };
  return {
    read(ask, manual) {
      const mine = ++current;
      // A newer read supersedes the one Checking belonged to.
      stopChecking();
      if (manual) {
        checkingFor = mine;
        events.checking(true);
      }
      ask().then(
        (answer) => {
          if (mine !== current) return;
          stopChecking();
          events.keep(answer, manual);
        },
        () => {
          if (mine !== current) return;
          stopChecking();
          events.fail();
        },
      );
    },
    invalidate() {
      current += 1;
      stopChecking();
    },
  };
}
