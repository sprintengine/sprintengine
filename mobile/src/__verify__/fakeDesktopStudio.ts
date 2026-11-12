import {
  CONVERSATION_PROTOCOL_MIN_SUPPORTED,
  CONVERSATION_PROTOCOL_VERSION,
} from "../../../packages/conversation-protocol/src/public";
import {
  STUDIO_CAPABILITIES,
  STUDIO_PROTOCOL_MIN_SUPPORTED,
  STUDIO_PROTOCOL_VERSION,
  type StudioScope,
} from "../../../packages/studio-protocol/src/public";
import type { StudioWebSocketConstructor } from "../../../packages/client-runtime/src/public";

// A paired desktop's Studio, as the phone's suite meets it: its ticket route
// (the device token buys a ticket good once) and its Studio socket speaking
// the real frames, with the answers a test gives per method. What the phone
// sends is kept for the test to read.

type Answer = unknown | { error: { code: string; message: string } };

export type FakeDesktopStudio = {
  fetchImpl: typeof fetch;
  WebSocket: StudioWebSocketConstructor;
  /** Every request, in order: the method and its params. */
  requests: Array<{ method: string; params: Record<string, unknown> }>;
  /** Every ticket request's headers. */
  ticketHeaders: Array<Record<string, string>>;
  /** Every socket's URL. */
  socketUrls: string[];
  /** Drop every open socket, as a backgrounded phone's are. */
  cut(): void;
};

export function fakeDesktopStudio(input: {
  answer: (method: string, params: Record<string, unknown>) => Answer | Promise<Answer>;
  scopes?: StudioScope[];
  /** The status the ticket route answers with; 200 unless given. */
  ticketStatus?: () => number;
  /** A desktop from before the Studio protocol: its tickets name no Studio path. */
  outdated?: boolean;
}): FakeDesktopStudio {
  const requests: FakeDesktopStudio["requests"] = [];
  const ticketHeaders: FakeDesktopStudio["ticketHeaders"] = [];
  const socketUrls: string[] = [];
  const open = new Set<{ drop(): void }>();
  let minted = 0;

  const fetchImpl = (async (_url: string, init: { headers: Record<string, string> }) => {
    ticketHeaders.push(init.headers);
    const status = input.ticketStatus?.() ?? 200;
    const body =
      status === 200
        ? { ticket: `mctk_${++minted}`, path: "/tailnet/v1/stream", ...(input.outdated ? {} : { studioPath: "/tailnet/v1/studio" }) }
        : { error: { code: "unauthorized", message: "No." } };
    return { ok: status === 200, status, json: async () => body };
  }) as unknown as typeof fetch;

  class FakeSocket {
    readyState = 0;
    private listeners: Record<string, Array<(event: never) => void>> = {};
    private ticket: string;
    constructor(url: string) {
      socketUrls.push(url);
      this.ticket = new URL(url).searchParams.get("ticket") ?? "";
      const handle = { drop: () => this.close(1006, "cut") };
      open.add(handle);
      setTimeout(() => {
        this.readyState = 1;
        this.emit("open", {});
      }, 0);
      this.handle = handle;
    }
    private handle: { drop(): void };
    addEventListener(type: string, listener: (event: never) => void) {
      (this.listeners[type] ??= []).push(listener);
    }
    private emit(type: string, event: unknown) {
      for (const listener of this.listeners[type] ?? []) listener(event as never);
    }
    private reply(frame: unknown) {
      setTimeout(() => this.emit("message", { data: JSON.stringify(frame) }), 0);
    }
    send(text: string) {
      const frame = JSON.parse(text) as Record<string, unknown>;
      if (frame.t === "hello") {
        const auth = frame.auth as { token?: string };
        if (auth.token !== this.ticket) {
          this.reply({ t: "bye", code: "unauthorized", message: "Wrong ticket." });
          return;
        }
        this.reply({
          t: "welcome",
          protocolVersion: STUDIO_PROTOCOL_VERSION,
          minProtocolVersion: STUDIO_PROTOCOL_MIN_SUPPORTED,
          server: { name: "SprintEngine Studio", version: "9.9.9" },
          environment: { id: "env-mac-mini", hostKind: "local", os: "darwin", arch: "arm64" },
          capabilities: [...STUDIO_CAPABILITIES],
          conversation: {
            protocolVersion: CONVERSATION_PROTOCOL_VERSION,
            minProtocolVersion: CONVERSATION_PROTOCOL_MIN_SUPPORTED,
            capabilities: [],
          },
          grant: {
            clientId: "tailnet:device-1",
            name: "android-phone",
            owner: false,
            scopes: input.scopes ?? ["conversation:read", "conversation:operate", "conversation:create", "workspaces:read"],
            ceiling: "bypass",
          },
        });
        return;
      }
      if (frame.t === "req") {
        const method = frame.method as string;
        const params = (frame.params ?? {}) as Record<string, unknown>;
        requests.push({ method, params });
        void Promise.resolve(input.answer(method, params)).then((answer) => {
          const refused = answer && typeof answer === "object" && "error" in (answer as object);
          this.reply(
            refused
              ? { t: "res", id: frame.id, ok: false, error: (answer as { error: unknown }).error }
              : { t: "res", id: frame.id, ok: true, result: answer },
          );
        });
      }
    }
    close(code = 1000, reason = "") {
      if (this.readyState === 3) return;
      this.readyState = 3;
      open.delete(this.handle);
      setTimeout(() => this.emit("close", { code, reason }), 0);
    }
  }

  return {
    fetchImpl,
    WebSocket: FakeSocket as unknown as StudioWebSocketConstructor,
    requests,
    ticketHeaders,
    socketUrls,
    cut: () => {
      for (const socket of [...open]) socket.drop();
    },
  };
}
