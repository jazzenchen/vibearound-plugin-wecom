/**
 * WeCom stream renderer — uses replyStream to replace message content.
 *
 * WeCom `replyStream` uses a single `streamId` per inbound message and
 * REPLACES the content each time. This renderer rebuilds the full message
 * from scratch on every flush: header + sealed blocks + current block.
 *
 * Overrides onSystemText/onAgentReady/onSessionReady to accumulate in header
 * (instead of sending separate messages via sendText).
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

  /** Persistent header per turn: agent info, session id, system messages. */
  private header = new Map<string, string[]>();
  /** Completed blocks from this turn. */
  private sealedBlocks = new Map<string, string[]>();
  /** Currently-streaming block content. */
  private currentBlock = new Map<string, string>();

  constructor(wecomBot: WeComBot, log: LogFn, verbose?: Partial<VerboseConfig>) {
    super({
      streaming: true,
      flushIntervalMs: 800,
      minEditIntervalMs: 1000,
      verbose,
    });
    this.wecomBot = wecomBot;
    this.log = log;
  }

  protected async sendText(chatId: string, text: string): Promise<void> {
    // For standalone system text outside a turn, send directly
    await this.wecomBot.replyMarkdown(chatId, text, true);
  }

  protected formatContent(kind: BlockKind, content: string, _sealed: boolean): string {
    switch (kind) {
      case "thinking": return `> 💭 ${content}`;
      case "tool":     return `\`${content.trim()}\``;
      case "text":     return content;
    }
  }

  protected async sendBlock(chatId: string, _kind: BlockKind, content: string): Promise<string | null> {
    const prev = this.currentBlock.get(chatId);
    if (prev) {
      const sealed = this.sealedBlocks.get(chatId) ?? [];
      sealed.push(prev);
      this.sealedBlocks.set(chatId, sealed);
    }
    this.currentBlock.set(chatId, content);
    await this.flushToWeCom(chatId, false);
    return "stream";
  }

  protected async editBlock(
    chatId: string,
    _ref: string,
    _kind: BlockKind,
    content: string,
    _sealed: boolean,
  ): Promise<void> {
    this.currentBlock.set(chatId, content);
    await this.flushToWeCom(chatId, false);
  }

  protected async onAfterTurnEnd(chatId: string): Promise<void> {
    await this.flushToWeCom(chatId, true);
    this.clearState(chatId);
    this.log("debug", `turn_complete session=${chatId}`);
  }

  protected async onAfterTurnError(chatId: string, error: string): Promise<void> {
    this.currentBlock.set(chatId, `❌ Error: ${error}`);
    await this.flushToWeCom(chatId, true);
    this.clearState(chatId);
  }

  // Override prompt lifecycle to clear WeCom-specific state
  onPromptSent(chatId: string): void {
    this.clearState(chatId);
    super.onPromptSent(chatId);
  }

  // Override notification handlers — accumulate in header instead of sendText
  onSystemText(chatId: string, text: string): void {
    this.appendHeader(chatId, text);
    this.flushToWeCom(chatId, false).catch(() => {});
  }

  onAgentReady(chatId: string, agent: string, version: string): void {
    this.appendHeader(chatId, `🤖 Agent: ${agent} v${version}`);
    this.flushToWeCom(chatId, false).catch(() => {});
  }

  onSessionReady(chatId: string, sessionId: string): void {
    this.appendHeader(chatId, `📋 Session: ${sessionId}`);
    this.flushToWeCom(chatId, false).catch(() => {});
  }

  // --- Internals ---

  private appendHeader(chatId: string, text: string): void {
    const h = this.header.get(chatId) ?? [];
    h.push(text);
    this.header.set(chatId, h);
  }

  private buildFull(chatId: string): string {
    const h = this.header.get(chatId) ?? [];
    const sealed = this.sealedBlocks.get(chatId) ?? [];
    const current = this.currentBlock.get(chatId) ?? "";
    const parts: string[] = [];
    if (h.length > 0) parts.push(h.join("\n"));
    if (sealed.length > 0) parts.push(sealed.join("\n\n"));
    if (current) parts.push(current);
    return parts.join("\n\n");
  }

  private async flushToWeCom(chatId: string, finish: boolean): Promise<void> {
    const full = this.buildFull(chatId);
    if (full) await this.wecomBot.replyMarkdown(chatId, full, finish);
  }

  private clearState(chatId: string): void {
    this.header.delete(chatId);
    this.sealedBlocks.delete(chatId);
    this.currentBlock.delete(chatId);
  }
}
