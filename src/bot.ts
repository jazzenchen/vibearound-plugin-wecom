/**
 * WeComBot — wraps @wecom/aibot-node-sdk for WebSocket persistent connection.
 *
 * Handles:
 *   - WSClient connection lifecycle (WebSocket, no public IP)
 *   - Inbound text/image messages → ACP prompt() to Host
 *   - Reply via wsClient.replyStream() (markdown supported)
 *   - File download via WeComApiClient (5-min URL with aeskey)
 */

import {
  WSClient,
  type BaseMessage,
  type TextMessage,
  type WsFrame,
} from "@wecom/aibot-node-sdk";
import type { Agent, ContentBlock } from "@vibearound/plugin-channel-sdk";
import type { AgentStreamHandler } from "./agent-stream.js";

export interface WeComConfig {
  bot_id: string;
  secret: string;
}

type LogFn = (level: string, msg: string) => void;

interface PendingFrame {
  /** Original WS frame, kept for replyStream req_id passthrough */
  frame: WsFrame<BaseMessage>;
  /** Stream id used for replyStream — must be stable across one turn */
  streamId: string;
}

export class WeComBot {
  private client: WSClient;
  private agent: Agent;
  private log: LogFn;
  private cacheDir: string;
  private streamHandler: AgentStreamHandler | null = null;
  /** Map channelId → latest pending frame, used for replying */
  private pending = new Map<string, PendingFrame>();

  constructor(config: WeComConfig, agent: Agent, log: LogFn, cacheDir: string) {
    this.agent = agent;
    this.log = log;
    this.cacheDir = cacheDir;

    this.client = new WSClient({
      botId: config.bot_id,
      secret: config.secret,
      maxReconnectAttempts: -1, // infinite reconnect
    });
  }

  setStreamHandler(handler: AgentStreamHandler): void {
    this.streamHandler = handler;
  }

  /**
   * Resolve a stable channelId for the WeCom message.
   * - Group chats: chatid
   * - Single (DM): from.userid
   */
  private channelIdOf(msg: BaseMessage): string {
    if (msg.chattype === "group" && msg.chatid) {
      return `wecom:group:${msg.chatid}`;
    }
    return `wecom:user:${msg.from?.userid ?? "unknown"}`;
  }

  /** Get the pending frame for a channel (used by stream handler to reply). */
  getPendingFrame(channelId: string): PendingFrame | null {
    return this.pending.get(channelId) ?? null;
  }

  /** Reply to a WeCom message with streaming markdown content. */
  async replyMarkdown(channelId: string, content: string, finish: boolean): Promise<void> {
    const pending = this.pending.get(channelId);
    if (!pending) {
      this.log("warn", `no pending frame for channel=${channelId}, dropping reply`);
      return;
    }
    try {
      await this.client.replyStream(pending.frame, pending.streamId, content, finish);
      if (finish) {
        // Clear after final reply
        this.pending.delete(channelId);
      }
    } catch (e) {
      const err = e as { message?: string };
      this.log("error", `replyStream failed: ${err.message ?? String(e)}`);
    }
  }

  async start(): Promise<void> {
    this.client.on("connected", () => {
      this.log("info", "WeCom WebSocket connected");
    });

    this.client.on("authenticated", () => {
      this.log("info", "WeCom authenticated");
    });

    this.client.on("disconnected", (reason: string) => {
      this.log("warn", `WeCom disconnected: ${reason}`);
    });

    this.client.on("error", (err: Error) => {
      this.log("error", `WeCom error: ${err.message}`);
    });

    // Handle text messages
    this.client.on("message.text", (frame: WsFrame<TextMessage>) => {
      void this.handleTextMessage(frame);
    });

    // Connect (synchronous chainable, returns this)
    this.client.connect();
    this.log("info", "WeCom WSClient connecting...");
  }

  async stop(): Promise<void> {
    try {
      this.client.disconnect();
    } catch {
      // ignore
    }
  }

  private async handleTextMessage(frame: WsFrame<TextMessage>): Promise<void> {
    const msg = frame.body;
    if (!msg) return;

    const text = msg.text?.content?.trim() ?? "";
    if (!text) return;

    const channelId = this.channelIdOf(msg);
    const senderId = msg.from?.userid ?? "unknown";

    // Generate a stream id for this turn (stable across all replyStream calls)
    const streamId = `${msg.msgid}-stream`;
    this.pending.set(channelId, { frame, streamId });

    this.log("debug", `message chat=${channelId} sender=${senderId} text=${text.slice(0, 80)}`);

    const contentBlocks: ContentBlock[] = [{ type: "text", text }];

    this.streamHandler?.onPromptSent(channelId);

    try {
      const response = await this.agent.prompt({
        sessionId: channelId,
        prompt: contentBlocks,
      });
      this.log("info", `prompt done chat=${channelId} stopReason=${response.stopReason}`);
      this.streamHandler?.onTurnEnd(channelId);
    } catch (error: unknown) {
      const errMsg =
        error instanceof Error
          ? error.message
          : typeof error === "object" && error !== null && "message" in error
            ? String((error as { message: unknown }).message)
            : String(error);
      this.log("error", `prompt failed chat=${channelId}: ${errMsg}`);
      this.streamHandler?.onTurnError(channelId, errMsg);
    }
  }
}
