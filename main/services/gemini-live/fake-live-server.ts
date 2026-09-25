import type {
  LiveSendClientContentParameters,
  LiveSendRealtimeInputParameters,
  LiveSendToolResponseParameters,
  LiveServerMessage,
} from "@google/genai";
import type {
  GeminiLiveConnectParameters,
  GeminiLiveConnector,
  GeminiLiveWireSession,
} from "./protocol.js";

export type FakeLiveClientMessage =
  | { type: "client_content"; value: LiveSendClientContentParameters }
  | { type: "realtime_input"; value: LiveSendRealtimeInputParameters }
  | { type: "tool_response"; value: LiveSendToolResponseParameters };

/** In-memory fake of the Google Live server boundary; it never opens a socket. */
export class FakeGeminiLiveServer {
  readonly connections: FakeGeminiLiveConnection[] = [];

  readonly connector: GeminiLiveConnector = async (params) => {
    const connection = new FakeGeminiLiveConnection(params);
    this.connections.push(connection);
    params.callbacks.onopen?.();
    return connection.session;
  };

  get latest(): FakeGeminiLiveConnection {
    const connection = this.connections[this.connections.length - 1];
    if (!connection) throw new Error("The fake Live server has no connection.");
    return connection;
  }
}

export class FakeGeminiLiveConnection {
  readonly received: FakeLiveClientMessage[] = [];
  readonly session: GeminiLiveWireSession;
  closed = false;

  constructor(readonly params: GeminiLiveConnectParameters) {
    const requireOpen = (): void => {
      if (this.closed) throw new Error("The fake Live connection is closed.");
    };
    this.session = {
      sendClientContent: (value) => {
        requireOpen();
        this.received.push({ type: "client_content", value });
      },
      sendRealtimeInput: (value) => {
        requireOpen();
        this.received.push({ type: "realtime_input", value });
      },
      sendToolResponse: (value) => {
        requireOpen();
        this.received.push({ type: "tool_response", value });
      },
      close: () => {
        if (this.closed) return;
        this.closed = true;
        this.params.callbacks.onclose?.({
          code: 1000,
          reason: "client_close",
          wasClean: true,
        } as CloseEvent);
      },
    };
  }

  emit(message: LiveServerMessage | Record<string, unknown>): void {
    if (this.closed) throw new Error("The fake Live connection is closed.");
    this.params.callbacks.onmessage(message as LiveServerMessage);
  }

  fail(): void {
    if (this.closed) return;
    this.params.callbacks.onerror?.({
      error: new Error("fake provider detail"),
    } as ErrorEvent);
  }

  disconnect(code = 1006): void {
    if (this.closed) return;
    this.closed = true;
    this.params.callbacks.onclose?.({
      code,
      reason: "fake provider detail",
      wasClean: false,
    } as CloseEvent);
  }
}
