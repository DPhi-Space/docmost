/**
 * After an offline boot the editor room holds a tokenless provider on the
 * shared socket; when the token arrives the room destroys it and attaches an
 * authenticated one under the same document name. The destroyed provider's
 * Close must not be queued on the never-opened socket, or it is flushed after
 * the new provider's Auth and the server closes the new connection by name.
 * Guarded by `patches/@hocuspocus__provider@4.5.0.patch`.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from "@hocuspocus/provider";

const sockets: FakeWebSocket[] = [];

class FakeWebSocket {
  readyState = 0;
  sent: Uint8Array[] = [];
  private handlers: Record<string, ((event: unknown) => void)[]> = {};
  constructor(public url: string) {
    sockets.push(this);
  }
  addEventListener(name: string, handler: (event: unknown) => void) {
    (this.handlers[name] ??= []).push(handler);
  }
  removeEventListener(name: string, handler: (event: unknown) => void) {
    this.handlers[name] = (this.handlers[name] ?? []).filter(
      (h) => h !== handler,
    );
  }
  send(data: ArrayBufferLike | Uint8Array) {
    this.sent.push(new Uint8Array(data as ArrayBuffer));
  }
  close() {
    this.readyState = 3;
  }
  fire(name: string, event: unknown) {
    for (const handler of this.handlers[name] ?? []) handler(event);
  }
}

const MESSAGE_TYPES: Record<number, string> = {
  0: "Sync",
  1: "Awareness",
  2: "Auth",
  7: "Close",
};

function decode(frame: Uint8Array): string {
  let i = 0;
  const readVarUint = () => {
    let n = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = frame[i++];
      n |= (byte & 127) << shift;
      shift += 7;
    } while (byte & 128);
    return n;
  };
  const length = readVarUint();
  const name = new TextDecoder().decode(frame.slice(i, i + length));
  i += length;
  const type = readVarUint();
  return `${MESSAGE_TYPES[type] ?? type}(${name})`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("tokenless provider replaced by an authenticated one", () => {
  let socket: HocuspocusProviderWebsocket | undefined;

  afterEach(() => {
    socket?.destroy();
    sockets.length = 0;
  });

  it("does not close the authenticated provider's document connection", async () => {
    socket = new HocuspocusProviderWebsocket({
      url: "ws://collab",
      autoConnect: false,
      WebSocketPolyfill: FakeWebSocket as unknown as typeof WebSocket,
    });

    const tokenless = new HocuspocusProvider({
      name: "page.X",
      websocketProvider: socket,
      token: undefined,
      flushDelay: 10,
    });
    tokenless.attach();
    tokenless.document.getText("t").insert(0, "offline edit");
    await sleep(30);

    tokenless.destroy();
    const authenticated = new HocuspocusProvider({
      name: "page.X",
      websocketProvider: socket,
      token: "jwt",
      flushDelay: 10,
    });
    authenticated.attach();
    socket.shouldConnect = true;
    void socket.connect();
    await sleep(10);

    const ws = sockets.at(-1)!;
    ws.readyState = 1;
    ws.fire("open", {});
    await sleep(10);
    // The first inbound frame flushes whatever was queued while offline.
    ws.fire("message", { data: new Uint8Array([9]).buffer });
    await sleep(10);

    const frames = ws.sent.map(decode);
    const auth = frames.indexOf("Auth(page.X)");
    expect(auth).toBeGreaterThanOrEqual(0);
    expect(frames.slice(auth)).not.toContain("Close(page.X)");

    authenticated.destroy();
  });
});
