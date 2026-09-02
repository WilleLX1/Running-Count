import type { Plugin } from "vite";
import type { Server } from "node:http";
import { Hub } from "./hub";

/**
 * Runs the co-op server inside the Vite dev server, so `npm run dev` is all
 * anyone needs. Production uses server/standalone.ts instead.
 */
export function coopPlugin(): Plugin {
  let hub: Hub | null = null;
  return {
    name: "running-count-coop",
    configureServer(server) {
      const http = server.httpServer as Server | null;
      if (!http) return;
      hub = new Hub();
      http.once("listening", () => {
        hub!.attach(http, "/coop");
        server.config.logger.info("  ➜  co-op:   ws://localhost:<port>/coop");
      });
    },
    closeBundle() {
      hub?.stop();
      hub = null;
    },
  };
}
