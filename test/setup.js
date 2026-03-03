/**
 * Test setup - creates and manages the test server.
 */

import os from "os";
import fs from "fs/promises";
import path from "path";
import { createApp } from "../src/server.js";
import { setApiKey } from "../src/env.js";
import { init } from "../src/config.js";

const TEST_API_KEY = process.env.API_KEY || "test";
const TEST_PORT = process.env.TEST_PORT || 0; // 0 = random available port

let server = null;
let baseUrl = null;
let toolsDir = null;

export async function startTestServer() {
  if (server) return baseUrl;

  // Allow test temp directories (outside home dir on macOS)
  process.env.OPEN_TERMINAL_SANDBOX_HOME = os.tmpdir();
  process.env.OPEN_TERMINAL_USER_FS_DIR = os.tmpdir();

  // Create tools directory with ready marker for execute tests
  toolsDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "open-terminal-lite-tools-"),
  );
  process.env.TOOLS_VOLUME = toolsDir;
  await fs.writeFile(path.join(toolsDir, ".ready"), "");

  // Create log directory for execute tests
  const logDir = path.join(toolsDir, "logs");
  await fs.mkdir(logDir, { recursive: true });
  process.env.OPEN_TERMINAL_LOG_DIR = logDir;

  init(null);
  setApiKey(TEST_API_KEY);
  process.env.OPEN_TERMINAL_API_KEY = TEST_API_KEY;

  const app = createApp();

  return new Promise((resolve) => {
    server = app.listen(TEST_PORT, "127.0.0.1", () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve(baseUrl);
    });
  });
}

export async function stopTestServer() {
  if (server) {
    await new Promise((resolve) => {
      server.close(resolve);
      server = null;
      baseUrl = null;
    });
  }
  if (toolsDir) {
    await fs.rm(toolsDir, { recursive: true, force: true });
    toolsDir = null;
  }
}

export function getBaseUrl() {
  return baseUrl;
}

export function getApiKey() {
  return TEST_API_KEY;
}

export function authHeaders() {
  return {
    Authorization: `Bearer ${TEST_API_KEY}`,
    "Content-Type": "application/json",
  };
}
