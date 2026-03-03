/**
 * MCP server — exposes Open Terminal operations as MCP tools.
 *
 * Tools are auto-registered from the shared handlers module,
 * ensuring 1:1 parity with the HTTP API.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import path from 'path';
import fsp from 'fs/promises';
import * as env from './env.js';
import { allHandlers } from './handlers.js';

/**
 * Create the execution context for handlers.
 * This provides sandbox resolution and environment config.
 */
function createContext() {
  const userFsDir = path.resolve(env.USER_FS_DIR);
  const sandboxHomeDir = path.resolve(env.SANDBOX_HOME_DIR);

  return {
    userFsDir,
    sandboxHomeDir,
    logDir: env.LOG_DIR,
    binaryMimePrefixes: env.BINARY_FILE_MIME_PREFIXES,

    /**
     * Resolve a path within the sandbox.
     * Prevents directory traversal attacks.
     */
    resolvePath(inputPath) {
      if (!inputPath || inputPath === '.') {
        return userFsDir;
      }

      let resolved;
      if (path.isAbsolute(inputPath)) {
        resolved = path.normalize(inputPath);
      } else {
        resolved = path.resolve(userFsDir, inputPath);
      }

      // Ensure resolved path is within sandbox
      if (
        !resolved.startsWith(sandboxHomeDir + path.sep) &&
        resolved !== sandboxHomeDir
      ) {
        throw new Error('Path escapes sandbox');
      }

      return resolved;
    },
  };
}

/**
 * Build the tools array from handlers.
 */
function buildTools() {
  return Object.values(allHandlers).map((h) => h.schema);
}

/**
 * Build a lookup map from tool name to handler.
 */
function buildHandlerMap() {
  const map = new Map();
  for (const h of Object.values(allHandlers)) {
    map.set(h.schema.name, h.handler);
  }
  return map;
}

/**
 * Start the MCP server.
 */
export async function startMcpServer({
  transport = 'stdio',
  host: _host,
  port: _port,
}) {
  const tools = buildTools();
  const handlerMap = buildHandlerMap();
  const ctx = createContext();

  // Ensure the userFsDir exists (similar to entrypoint.sh setup)
  await fsp.mkdir(ctx.userFsDir, { recursive: true });

  const server = new Server(
    {
      name: 'open-terminal-lite',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const handler = handlerMap.get(name);
    if (!handler) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: `Unknown tool: ${name}` }),
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await handler(args || {}, ctx);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [
          { type: 'text', text: JSON.stringify({ error: err.message }) },
        ],
        isError: true,
      };
    }
  });

  if (transport === 'stdio') {
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
    console.error('MCP server running on stdio');
  } else {
    throw new Error('streamable-http transport not yet implemented');
  }
}
