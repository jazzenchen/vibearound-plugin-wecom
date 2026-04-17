/**
 * WeComBot — wraps @wecom/aibot-node-sdk for WebSocket persistent connection.
 *
 * Handles:
 *   - WSClient connection lifecycle (WebSocket, no public IP)
 *   - Inbound text/image messages → ACP prompt() to Host
 *   - Reply via wsClient.replyStream() (markdown supported)
 *   - File download via WeComApiClient (5-min URL with aeskey)
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  WSClient,
  type BaseMessage,
  type ImageContent,
  type ImageMessage,
  type MixedMessage,
  type TextMessage,
  type WsFrame,
} from "@wecom/aibot-node-sdk";
import type { Agent, ContentBlock } from "@vibearound/plugin-channel-sdk";
import { extractErrorMessage } from "@vibearound/plugin-channel-sdk";
import type { AgentStreamHandler } from "./agent-stream.js";

interface DownloadedImage {
  readonly path: string;
  readonly mimeType: string;
  readonly fileName: string;
}

function mimeFromFilename(fileName: string | undefined): string {
  const lower = (fileName ?? "").toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".bmp")) return "image/bmp";
  return "image/jpeg";
}

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
  /** Map chatId → latest pending frame, used for replying */
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
   * Resolve a stable chatId for the WeCom message.
   * - Group chats: chatid
   * - Single (DM): from.userid
   */
  private chatIdOf(msg: BaseMessage): string {
    if (msg.chattype === "group" && msg.chatid) {
      return `group:${msg.chatid}`;
    }
    return `dm:${msg.from?.userid ?? "unknown"}`;
  }

  /** Get the pending frame for a channel (used by stream handler to reply). */
  getPendingFrame(chatId: string): PendingFrame | null {
    return this.pending.get(chatId) ?? null;
  }

  /** Reply to a WeCom message with streaming markdown content. */
  async replyMarkdown(chatId: string, content: string, finish: boolean): Promise<void> {
    const pending = this.pending.get(chatId);
    if (!pending) {
      this.log("warn", `no pending frame for channel=${chatId}, dropping reply`);
      return;
    }
    try {
      await this.client.replyStream(pending.frame, pending.streamId, content, finish);
      if (finish) {
        // Clear after final reply
        this.pending.delete(chatId);
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

    // Handle inbound message variants. WeCom AiBotSDK emits one event per
    // msgtype — text, image, and mixed (text + image) are the interactive
    // ones we care about. Voice/file/video are routed through the same
    // handler as text: the generic path grabs whatever fields are present.
    this.client.on("message.text", (frame: WsFrame<TextMessage>) => {
      void this.handleMessage(frame);
    });
    this.client.on("message.image", (frame: WsFrame<ImageMessage>) => {
      void this.handleMessage(frame);
    });
    this.client.on("message.mixed", (frame: WsFrame<MixedMessage>) => {
      void this.handleMessage(frame);
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

  /**
   * Shape an inbound WeCom frame (text / image / mixed) into ACP content
   * blocks, downloading any encrypted images to a local cache first. All
   * three WsFrame variants share the same top-level fields we need, so we
   * widen to `BaseMessage` and key off `msgtype` internally.
   */
  private async handleMessage(frame: WsFrame<BaseMessage>): Promise<void> {
    const msg = frame.body;
    if (!msg) return;

    const chatId = this.chatIdOf(msg);
    const senderId = msg.from?.userid ?? "unknown";

    // Extract text + image items up-front so we can log and decide whether
    // the message is actually worth forwarding to the agent.
    const texts: string[] = [];
    const images: ImageContent[] = [];

    if (msg.msgtype === "text") {
      const textMsg = msg as TextMessage;
      const content = textMsg.text?.content?.trim();
      if (content) texts.push(content);
    } else if (msg.msgtype === "image") {
      const imageMsg = msg as ImageMessage;
      if (imageMsg.image) images.push(imageMsg.image);
    } else if (msg.msgtype === "mixed") {
      const mixedMsg = msg as MixedMessage;
      for (const item of mixedMsg.mixed?.msg_item ?? []) {
        if (item.msgtype === "text") {
          const content = item.text?.content?.trim();
          if (content) texts.push(content);
        } else if (item.msgtype === "image" && item.image) {
          images.push(item.image);
        }
      }
    } else {
      this.log("debug", `ignoring unsupported msgtype=${msg.msgtype} chat=${chatId}`);
      return;
    }

    if (texts.length === 0 && images.length === 0) {
      this.log("debug", `empty message chat=${chatId} msgtype=${msg.msgtype}, skipping`);
      return;
    }

    // Generate a stream id for this turn (stable across all replyStream calls).
    // Pin the pending frame so agent-stream's replyStream calls find it.
    const streamId = `${msg.msgid}-stream`;
    this.pending.set(chatId, { frame, streamId });

    const preview = texts.join(" ").slice(0, 80);
    this.log(
      "debug",
      `message chat=${chatId} sender=${senderId} msgtype=${msg.msgtype} texts=${texts.length} images=${images.length} preview=${preview}`,
    );

    // Download every attached image into the cache directory. Skip any
    // that fail — the agent can still handle whatever successfully
    // downloaded plus the text.
    const downloaded: DownloadedImage[] = [];
    for (const image of images) {
      const local = await this.downloadImage(chatId, msg.msgid, image).catch(
        (err: unknown) => {
          this.log(
            "warn",
            `failed to download image url=${image.url}: ${extractErrorMessage(err)}`,
          );
          return null;
        },
      );
      if (local) downloaded.push(local);
    }

    // Build content blocks. Text first (if any), then a synthesized
    // description when the message is image-only, then resource_link
    // blocks for each downloaded image. Using file:// URIs lets the
    // ACPPod relocate step hand them off to the Claude workspace the
    // same way it does for feishu/discord.
    const contentBlocks: ContentBlock[] = [];
    if (texts.length > 0) {
      contentBlocks.push({ type: "text", text: texts.join("\n") });
    } else if (downloaded.length > 0) {
      contentBlocks.push({
        type: "text",
        text: `The user sent ${downloaded.length} image${downloaded.length > 1 ? "s" : ""}.`,
      });
    }
    for (const image of downloaded) {
      contentBlocks.push({
        type: "resource_link",
        uri: `file://${image.path}`,
        name: image.fileName,
        mimeType: image.mimeType,
      });
    }

    if (contentBlocks.length === 0) {
      this.log("warn", `no content blocks produced for chat=${chatId}, dropping`);
      this.pending.delete(chatId);
      return;
    }

    const firstText = contentBlocks[0]?.type === "text" ? contentBlocks[0].text : "";
    if (firstText && this.streamHandler?.consumePendingText(chatId, firstText)) {
      this.pending.delete(chatId);
      return;
    }

    this.streamHandler?.onPromptSent(chatId);

    try {
      const response = await this.agent.prompt({
        sessionId: chatId,
        prompt: contentBlocks,
      });
      this.log("info", `prompt done chat=${chatId} stopReason=${response.stopReason}`);
      this.streamHandler?.onTurnEnd(chatId);
    } catch (error: unknown) {
      const errMsg = extractErrorMessage(error);
      this.log("error", `prompt failed chat=${chatId}: ${errMsg}`);
      this.streamHandler?.onTurnError(chatId, errMsg);
    }
  }

  /**
   * Download and decrypt a WeCom image via the SDK. Images are cached by
   * msgid so retries of the same message don't re-download. Returns the
   * cached file path plus metadata needed to build a resource_link block.
   */
  private async downloadImage(
    chatId: string,
    msgid: string,
    image: ImageContent,
  ): Promise<DownloadedImage> {
    // WeCom download URLs expire in 5 minutes and contain a signed query
    // string, so we can't safely derive a stable cache key from the URL.
    // msgid is stable for the lifetime of a conversation, and images are
    // one-per-message in the pure-image case; for mixed messages we fall
    // back to hashing the URL path to disambiguate.
    const urlPath = (() => {
      try {
        return new URL(image.url).pathname;
      } catch {
        return image.url;
      }
    })();
    const urlHint = path.basename(urlPath).replace(/[^a-zA-Z0-9._-]/g, "_");
    const safeChannel = chatId.replace(/[^a-zA-Z0-9._-]/g, "_");
    const dir = path.join(this.cacheDir, "wecom", safeChannel);
    const baseName = `${msgid}-${urlHint || "image"}`;

    this.log(
      "debug",
      `downloading image msgid=${msgid} chat=${chatId} url=${image.url}`,
    );

    const { buffer, filename } = await this.client.downloadFile(
      image.url,
      image.aeskey,
    );

    // SDK sometimes returns a filename with extension; prefer it.
    const effectiveName = filename ?? `${baseName}.jpg`;
    const ext = path.extname(effectiveName) || ".jpg";
    const localPath = path.join(dir, `${baseName}${ext}`);

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(localPath, buffer);

    this.log(
      "debug",
      `cached image ${buffer.length} bytes → ${localPath}`,
    );

    return {
      path: localPath,
      mimeType: mimeFromFilename(effectiveName),
      fileName: effectiveName,
    };
  }
}
