#!/usr/bin/env node
/**
 * VibeAround WeCom Plugin — ACP Client
 *
 * Spawned by the Rust host as a child process.
 * WeCom (企业微信) uses WebSocket persistent connection — no public IP required.
 */

import { runChannelPlugin } from "@vibearound/plugin-channel-sdk";

import { WeComBot } from "./bot.js";
import { AgentStreamHandler } from "./agent-stream.js";

runChannelPlugin({
  name: "vibearound-wecom",
  version: "0.1.0",
  requiredConfig: ["bot_id", "secret"],
  createBot: ({ config, agent, log, cacheDir }) =>
    new WeComBot(
      {
        bot_id: config.bot_id as string,
        secret: config.secret as string,
      },
      agent,
      log,
      cacheDir,
    ),
  createRenderer: (bot, log, verbose) =>
    new AgentStreamHandler(bot, log, verbose),
});
