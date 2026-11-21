import { useEffect } from "react";

/** Only a Simulator launch can supply this prop, through the scene delegate. */
export function useSwitcherProbe(port: number | undefined) {
  useEffect(() => {
    if (port === undefined) return;
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.onmessage = ({ data }) => {
      if (data !== "block") return;
      const startedAt = Date.now();
      const unblockAt = startedAt + 30_000;
      socket.send(JSON.stringify({ startedAt, unblockAt }));
      // Keep a single JS callback on the stack so it cannot handle AppState
      // events or update the React tree while UIKit takes the snapshot.
      while (Date.now() < unblockAt) {
        // The loop is bounded even if the test driver exits.
      }
      socket.send("resumed");
    };
    return () => socket.close();
  }, [port]);
}
