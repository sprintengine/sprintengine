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
  /** Every ticket request's body, as sent. */
  ticketBodies: Array<Record<string, unknown>>;
  /** Every socket's URL. */
  socketUrls: string[];
  /** Drop every open socket, as a backgrounded phone's are. */
  cut(): void;
  /** The push topics followed now, by subscription id. */
  subscriptions: Map<string, string>;
  /** Say something on a push topic to whoever follows it. */
  push(topic: string, payload: unknown): void;
  /** Every chat followed (`conversation.session`), in order: its params and the cursor it resumed from. */
  follows: Array<{ params: Record<string, unknown>; cursor?: { afterSeq: number; generation: string } }>;
  /** Send a frame of a followed chat to every subscription to it now. */
  frame(frame: Record<string, unknown>): void;
  /** Refuse the follows open now (`subFailed`). */
  refuseFollows(refusal: { code: string; message: string; retryable: boolean; retryAfterMs?: number }): void;
  /** Say goodbye on every open socket, as a revoked pairing is told. */
  bye(code: string, message: string): void;
};

export function fakeDesktopStudio(input: {
  answer: (method: string, params: Record<string, unknown>) => Answer | Promise<Answer>;
  scopes?: StudioScope[];
  /** The status the ticket route answers with; 200 unless given. */
  ticketStatus?: () => number;
  /** A desktop from before the Studio protocol: its tickets name no Studio path. */
  outdated?: boolean;
  /** What its chats serve (`conversation.capabilities` in its welcome). */
  conversationCapabilities?: string[];
  /** A chat followed: the frames it answers with at once (a snapshot or the missed events, then a fence). */
  follow?: (
    params: Record<string, unknown>,
    cursor: { afterSeq: number; generation: string } | undefined,
  ) => Array<Record<string, unknown>>;
}): FakeDesktopStudio {
  const requests: FakeDesktopStudio["requests"] = [];
  const ticketHeaders: FakeDesktopStudio["ticketHeaders"] = [];
  const ticketBodies: FakeDesktopStudio["ticketBodies"] = [];
  const socketUrls: string[] = [];
  type Open = {
    drop(): void;
    push(topic: string, payload: unknown): void;
    frame(frame: Record<string, unknown>): void;
    refuse(refusal: Record<string, unknown>): void;
    bye(code: string, message: string): void;
  };
  const open = new Set<Open>();
  const follows: FakeDesktopStudio["follows"] = [];
  const subscriptions = new Map<string, string>();
  let minted = 0;

  const fetchImpl = (async (_url: string, init: { headers: Record<string, string>; body?: string }) => {
    ticketHeaders.push(init.headers);
    const asked = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
    ticketBodies.push(asked);
    // A machine the desktop relays: its own Studio path on the same listener.
    const studioPath =
      typeof asked.environmentId === "string"
        ? `/tailnet/v1/environments/${asked.environmentId}/studio`
        : "/tailnet/v1/studio";
    const status = input.ticketStatus?.() ?? 200;
    const body =
      status === 200
        ? { ticket: `mctk_${++minted}`, path: "/tailnet/v1/stream", ...(input.outdated ? {} : { studioPath }) }
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
      const handle: Open = {
        drop: () => this.close(1006, "cut"),
        push: (topic: string, payload: unknown) => {
          for (const [id, followed] of this.followed) if (followed === topic) this.reply({ t: "push", sub: id, payload });
        },
        frame: (frame) => {
          for (const [id, followed] of this.followed)
            if (followed === "conversation.session") this.reply({ t: "frame", sub: id, frame });
        },
        refuse: (refusal) => {
          for (const [id, followed] of [...this.followed])
            if (followed === "conversation.session") {
              this.followed.delete(id);
              this.reply({ t: "subFailed", sub: id, ...refusal });
            }
        },
        bye: (code, message) => {
          this.reply({ t: "bye", code, message });
          setTimeout(() => this.close(1000, message), 1);
        },
      };
      open.add(handle);
      setTimeout(() => {
        this.readyState = 1;
        this.emit("open", {});
      }, 0);
      this.handle = handle;
    }
    private handle: Open;
    private followed = new Map<string, string>();
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
            capabilities: input.conversationCapabilities ?? [],
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
      if (frame.t === "sub") {
        this.followed.set(frame.id as string, frame.topic as string);
        subscriptions.set(frame.id as string, frame.topic as string);
        if (frame.topic === "conversation.session") {
          const params = (frame.params ?? {}) as Record<string, unknown>;
          const cursor = frame.cursor as { afterSeq: number; generation: string } | undefined;
          follows.push({ params, ...(cursor ? { cursor } : {}) });
          for (const answer of input.follow?.(params, cursor) ?? [])
            this.reply({ t: "frame", sub: frame.id, frame: { key: params.key, ...answer } });
        }
        return;
      }
      if (frame.t === "unsub") {
        this.followed.delete(frame.id as string);
        subscriptions.delete(frame.id as string);
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
    ticketBodies,
    socketUrls,
    cut: () => {
      for (const socket of [...open]) socket.drop();
    },
    subscriptions,
    push: (topic, payload) => {
      for (const socket of open) socket.push(topic, payload);
    },
    follows,
    frame: (frame) => {
      for (const socket of open) socket.frame(frame);
    },
    refuseFollows: (refusal) => {
      for (const socket of open) socket.refuse(refusal);
    },
    bye: (code, message) => {
      for (const socket of [...open]) socket.bye(code, message);
    },
  };
}
