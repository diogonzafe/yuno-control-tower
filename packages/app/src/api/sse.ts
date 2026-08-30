import { createLogger } from "../logging.js";

const logger = createLogger("sse-hub");

const DEFAULT_HEARTBEAT_MS = 20_000;

// The minimal slice of Node's ServerResponse this hub needs, so tests can
// exercise it without a socket.
export type SseConnection = {
  write(chunk: string): boolean;
  on(event: "close", listener: () => void): void;
  end(): void;
};

export type SseHub = {
  register(connection: SseConnection): void;
  broadcast(event: string, data: unknown): void;
  connectionCount(): number;
  stop(): void;
};

export function createSseHub(heartbeatMs = DEFAULT_HEARTBEAT_MS): SseHub {
  const connections = new Set<SseConnection>();

  function send(connection: SseConnection, chunk: string): void {
    try {
      connection.write(chunk);
    } catch (error) {
      // A dead socket must not take down the broadcast for everyone else.
      connections.delete(connection);
      logger.error({ error }, "dropped an SSE connection that failed to write");
    }
  }

  const heartbeat = setInterval(() => {
    for (const connection of [...connections]) {
      send(connection, ": keepalive\n\n");
    }
  }, heartbeatMs);

  return {
    register(connection) {
      connections.add(connection);
      connection.on("close", () => connections.delete(connection));
    },
    broadcast(event, data) {
      const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const connection of [...connections]) {
        send(connection, chunk);
      }
    },
    connectionCount: () => connections.size,
    stop() {
      clearInterval(heartbeat);
      for (const connection of connections) {
        try {
          connection.end();
        } catch (error) {
          // A socket that is already gone must not throw and block shutdown.
          logger.error({ error }, "failed to end an SSE connection during shutdown");
        }
      }
      connections.clear();
    },
  };
}
