import { afterEach, describe, expect, it, vi } from "vitest";
import { createSseHub, type SseConnection } from "./sse.js";

function fakeConnection(options: { failOnWrite?: boolean; failOnEnd?: boolean } = {}) {
  const written: string[] = [];
  const closeListeners: Array<() => void> = [];
  let ended = false;
  const connection: SseConnection = {
    write(chunk) {
      if (options.failOnWrite) throw new Error("socket closed");
      written.push(chunk);
      return true;
    },
    on(_event, listener) { closeListeners.push(listener); },
    end() {
      if (options.failOnEnd) throw new Error("socket already closed");
      ended = true;
    },
  };
  return { connection, written, isEnded: () => ended, close: () => closeListeners.forEach((listener) => listener()) };
}

afterEach(() => { vi.useRealTimers(); });

describe("createSseHub", () => {
  it("writes the SSE wire format on broadcast", () => {
    const hub = createSseHub();
    const client = fakeConnection();
    hub.register(client.connection);

    hub.broadcast("signal", { windowBucket: "2026-08-30T14:06:00.000Z" });

    expect(client.written).toEqual([
      'event: signal\ndata: {"windowBucket":"2026-08-30T14:06:00.000Z"}\n\n',
    ]);
    hub.stop();
  });

  it("delivers to every registered connection", () => {
    const hub = createSseHub();
    const first = fakeConnection();
    const second = fakeConnection();
    hub.register(first.connection);
    hub.register(second.connection);

    hub.broadcast("evidence-gap", { attempts: 7 });

    expect(first.written).toHaveLength(1);
    expect(second.written).toHaveLength(1);
    expect(hub.connectionCount()).toBe(2);
    hub.stop();
  });

  it("drops a connection whose write throws, without failing the broadcast", () => {
    const hub = createSseHub();
    const healthy = fakeConnection();
    const broken = fakeConnection({ failOnWrite: true });
    hub.register(broken.connection);
    hub.register(healthy.connection);

    expect(() => hub.broadcast("signal", { ok: true })).not.toThrow();

    expect(healthy.written).toHaveLength(1);
    expect(hub.connectionCount()).toBe(1);
    hub.stop();
  });

  it("removes a connection when it closes", () => {
    const hub = createSseHub();
    const client = fakeConnection();
    hub.register(client.connection);

    client.close();

    expect(hub.connectionCount()).toBe(0);
    hub.stop();
  });

  it("sends a comment heartbeat so proxies keep the stream open", () => {
    vi.useFakeTimers();
    const hub = createSseHub(1000);
    const client = fakeConnection();
    hub.register(client.connection);

    vi.advanceTimersByTime(1000);

    expect(client.written).toEqual([": keepalive\n\n"]);
    hub.stop();
  });

  it("ends every registered connection on stop, so app.close() does not hang on an open SSE socket", () => {
    const hub = createSseHub();
    const first = fakeConnection();
    const second = fakeConnection();
    hub.register(first.connection);
    hub.register(second.connection);

    hub.stop();

    expect(first.isEnded()).toBe(true);
    expect(second.isEnded()).toBe(true);
    expect(hub.connectionCount()).toBe(0);
  });

  it("ends the other connections even when one connection's end() throws", () => {
    const hub = createSseHub();
    const healthy = fakeConnection();
    const broken = fakeConnection({ failOnEnd: true });
    hub.register(broken.connection);
    hub.register(healthy.connection);

    expect(() => hub.stop()).not.toThrow();

    expect(healthy.isEnded()).toBe(true);
  });
});
