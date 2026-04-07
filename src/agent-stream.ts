/**
 * AgentStreamHandler — receives ACP session updates from the Host and renders
 * them as WeCom replyStream messages (markdown supported).
 *
 * Uses replyStream which streams markdown content to a stable streamId per turn.
 */

import {
  BlockRenderer,
  type BlockKind,
  type VerboseConfig,
} from "@vibearound/plugin-channel-sdk";
import type { WeComBot } from "./bot.js";

type LogFn = (level: string, msg: string) => void;

export class AgentStreamHandler extends BlockRenderer<string> {
  private wecomBot: WeComBot;
  private log: LogFn;
  private lastChannelId: string | null = null;
  // Accumulated text for the current channel (replyStream wants the full content each call)
  private accum = new Map<string, string>();

  constructor(wecomBot: WeComBot, log: LogFn, verbose?: Partial<VerboseConfig>) {
    super({
      flushIntervalMs: 800,
      // WeCom replyStream supports updating the same streamId; throttle reasonable
      minEditIntervalMs: 1000,
      verbose,
    });
    this.wecomBot = wecomBot;
    this.log = log;
  }

  protected formatContent(kind: BlockKind, content: string, _sealed: boolean): string {
    switch (kind) {
      case "thinking":
        return `> 💭 ${content}`;
      case "tool":
        return `\`${content.trim()}\``;
      case "text":
        return content;
    }
  }

  /** Send (or replace) the current stream content. Returns a constant ref. */
  protected async sendBlock(
    channelId: string,
    _kind: BlockKind,
    content: string,
  ): Promise<string | null> {
    // Append to accumulated content for this channel
    const prev = this.accum.get(channelId) ?? "";
    const next = prev ? `${prev}\n\n${content}` : content;
    this.accum.set(channelId, next);

    await this.wecomBot.replyMarkdown(channelId, next, false);
    return "stream"; // single ref for the whole turn
  }

  /** Edit the current stream (just resend latest content). */
  protected async editBlock(
    channelId: string,
    _ref: string,
    _kind: BlockKind,
    content: string,
    sealed: boolean,
  ): Promise<void> {
    // Update last block content
    const prev = this.accum.get(channelId) ?? "";
    // Replace last block (everything after last \n\n) with new content
    const lastSeparator = prev.lastIndexOf("\n\n");
    const next =
      lastSeparator >= 0 ? `${prev.slice(0, lastSeparator + 2)}${content}` : content;
    this.accum.set(channelId, next);

    await this.wecomBot.replyMarkdown(channelId, next, sealed);
  }

  protected async onAfterTurnEnd(channelId: string): Promise<void> {
    // Send final reply with finish=true
    const final = this.accum.get(channelId);
    if (final) {
      await this.wecomBot.replyMarkdown(channelId, final, true);
    }
    this.accum.delete(channelId);
    this.log("debug", `turn_complete session=${channelId}`);
  }

  protected async onAfterTurnError(channelId: string, error: string): Promise<void> {
    await this.wecomBot.replyMarkdown(channelId, `❌ Error: ${error}`, true);
    this.accum.delete(channelId);
  }

  onPromptSent(channelId: string): void {
    this.lastChannelId = channelId;
    this.accum.delete(channelId);
    super.onPromptSent(channelId);
  }

  onAgentReady(agent: string, version: string): void {
    if (this.lastChannelId) {
      this.wecomBot
        .replyMarkdown(this.lastChannelId, `🤖 Agent: ${agent} v${version}`, false)
        .catch(() => {});
    }
  }

  onSessionReady(sessionId: string): void {
    if (this.lastChannelId) {
      this.wecomBot
        .replyMarkdown(this.lastChannelId, `📋 Session: ${sessionId}`, false)
        .catch(() => {});
    }
  }

  onSystemText(text: string): void {
    if (this.lastChannelId) {
      this.wecomBot.replyMarkdown(this.lastChannelId, text, false).catch(() => {});
    }
  }
}
