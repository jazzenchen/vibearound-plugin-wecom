/**
 * AgentStreamHandler — receives ACP session updates from the Host and renders
 * them as WeCom replyStream messages (markdown supported).
 *
 * WeCom `replyStream` uses a single `streamId` per inbound message and
 * REPLACES the content each time it is called. So this renderer must
 * rebuild the full message from scratch on every flush.
 *
 * State model (per channel):
 *   - header[]      : persistent lines (agent info, session id, system text)
 *   - sealedBlocks[]: completed content blocks from this turn
 *   - currentBlock  : the currently-streaming content block
 *
 * On every flush: replyStream(full = header + sealed + current, finish=false)
 * On turn end:    replyStream(full, finish=true)
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

  /** Persistent header per turn: agent info, session id, system messages. */
  private header = new Map<string, string[]>();
  /** Completed blocks from this turn (text/thinking/tool, already formatted). */
  private sealedBlocks = new Map<string, string[]>();
  /** Currently-streaming block content (already formatted by BlockRenderer). */
  private currentBlock = new Map<string, string>();

  constructor(wecomBot: WeComBot, log: LogFn, verbose?: Partial<VerboseConfig>) {
    super({
      flushIntervalMs: 800,
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

  /**
   * A new block starts. Seal the previous current block, then store the new
   * block as current and flush.
   */
  protected async sendBlock(
    channelId: string,
    _kind: BlockKind,
    content: string,
  ): Promise<string | null> {
    const prev = this.currentBlock.get(channelId);
    if (prev) {
      const sealed = this.sealedBlocks.get(channelId) ?? [];
      sealed.push(prev);
      this.sealedBlocks.set(channelId, sealed);
    }
    this.currentBlock.set(channelId, content);
    await this.flushToWeCom(channelId, false);
    return "stream";
  }

  /**
   * The current block has new content. Replace currentBlock (BlockRenderer
   * passes the FULL current block content, not a delta).
   */
  protected async editBlock(
    channelId: string,
    _ref: string,
    _kind: BlockKind,
    content: string,
    _sealed: boolean,
  ): Promise<void> {
    this.currentBlock.set(channelId, content);
    await this.flushToWeCom(channelId, false);
  }

  /** Build the full message = header + sealed blocks + current block. */
  private buildFull(channelId: string): string {
    const header = this.header.get(channelId) ?? [];
    const sealed = this.sealedBlocks.get(channelId) ?? [];
    const current = this.currentBlock.get(channelId) ?? "";
    const parts: string[] = [];
    if (header.length > 0) parts.push(header.join("\n"));
    if (sealed.length > 0) parts.push(sealed.join("\n\n"));
    if (current) parts.push(current);
    return parts.join("\n\n");
  }

  private async flushToWeCom(channelId: string, finish: boolean): Promise<void> {
    const full = this.buildFull(channelId);
    if (full) {
      await this.wecomBot.replyMarkdown(channelId, full, finish);
    }
  }

  protected async onAfterTurnEnd(channelId: string): Promise<void> {
    await this.flushToWeCom(channelId, true);
    this.header.delete(channelId);
    this.sealedBlocks.delete(channelId);
    this.currentBlock.delete(channelId);
    this.log("debug", `turn_complete session=${channelId}`);
  }

  protected async onAfterTurnError(channelId: string, error: string): Promise<void> {
    this.currentBlock.set(channelId, `❌ Error: ${error}`);
    await this.flushToWeCom(channelId, true);
    this.header.delete(channelId);
    this.sealedBlocks.delete(channelId);
    this.currentBlock.delete(channelId);
  }

  onPromptSent(channelId: string): void {
    // Clear any leftover state before starting a new turn
    this.header.delete(channelId);
    this.sealedBlocks.delete(channelId);
    this.currentBlock.delete(channelId);
    this.lastChannelId = channelId;
    super.onPromptSent(channelId);
  }

  onAgentReady(agent: string, version: string): void {
    if (this.lastChannelId) {
      const header = this.header.get(this.lastChannelId) ?? [];
      header.push(`🤖 Agent: ${agent} v${version}`);
      this.header.set(this.lastChannelId, header);
      this.flushToWeCom(this.lastChannelId, false).catch(() => {});
    }
  }

  onSessionReady(sessionId: string): void {
    if (this.lastChannelId) {
      const header = this.header.get(this.lastChannelId) ?? [];
      header.push(`📋 Session: ${sessionId}`);
      this.header.set(this.lastChannelId, header);
      this.flushToWeCom(this.lastChannelId, false).catch(() => {});
    }
  }

  onSystemText(text: string): void {
    if (this.lastChannelId) {
      const header = this.header.get(this.lastChannelId) ?? [];
      header.push(text);
      this.header.set(this.lastChannelId, header);
      this.flushToWeCom(this.lastChannelId, false).catch(() => {});
    }
  }
}
