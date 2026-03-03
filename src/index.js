#!/usr/bin/env node
/**
 * CLI entry point for Open Terminal.
 */

import { program } from 'commander';
import crypto from 'crypto';
import fs from 'fs';

import * as config from './config.js';
import { startServer } from './server.js';
import { BANNER } from './constants.js';

program
  .name('open-terminal-lite')
  .description('Terminal interaction API')
  .version('1.0.0');

program
  .command('run')
  .description('Start the API server')
  .option('--host <host>', 'Bind host (default: 0.0.0.0)')
  .option('--port <port>', 'Bind port (default: 8000)')
  .option(
    '--config <path>',
    'Path to a JSON config file (overrides user-level config location)',
  )
  .option('--cwd <dir>', 'Working directory for the server process')
  .option(
    '--api-key <key>',
    'Bearer API key (or set OPEN_TERMINAL_API_KEY env var)',
  )
  .option(
    '--cors-allowed-origins <origins>',
    'Allowed CORS origins, comma-separated (default: * for all)',
  )
  .action(async (opts) => {
    // Load config files before resolving other settings
    const cfg = config.init(opts.config);

    // Resolve host/port: CLI flag > config file > built-in default
    const host = opts.host || cfg.host || '0.0.0.0';
    const port = parseInt(opts.port || cfg.port || '8000', 10);

    if (opts.cwd) {
      try {
        process.chdir(opts.cwd);
      } catch (err) {
        console.error(
          `Error: cannot change to directory '${opts.cwd}': ${err.message}`,
        );
        process.exit(1);
      }
    }

    // Support Docker secrets: load from _FILE variant if no key was given
    let apiKey = opts.apiKey || process.env.OPEN_TERMINAL_API_KEY || '';

    if (!apiKey) {
      const filePath = process.env.OPEN_TERMINAL_API_KEY_FILE;
      if (filePath) {
        try {
          apiKey = fs.readFileSync(filePath, 'utf-8').trim();
        } catch (err) {
          console.error(
            `Error: cannot read API key file '${filePath}': ${err.message}`,
          );
          process.exit(1);
        }
      }
    }

    // Fall back to config file value
    if (!apiKey) {
      apiKey = cfg.api_key || '';
    }

    const generated = !apiKey;
    if (!apiKey) {
      apiKey = crypto.randomBytes(24).toString('base64url');
    }

    // Set CORS origins
    if (opts.corsAllowedOrigins) {
      process.env.OPEN_TERMINAL_CORS_ALLOWED_ORIGINS = opts.corsAllowedOrigins;
    }

    console.log(BANNER);
    if (generated) {
      console.log('='.repeat(60));
      console.log(`  API Key: ${apiKey}`);
      console.log('='.repeat(60));
    }
    console.log();

    await startServer({ host, port, apiKey });
  });

program
  .command('mcp')
  .description('Start the MCP server')
  .option(
    '--transport <transport>',
    'MCP transport (stdio or streamable-http)',
    'stdio',
  )
  .option('--host <host>', 'Bind host (streamable-http only)')
  .option('--port <port>', 'Bind port (streamable-http only)')
  .option('--config <path>', 'Path to a JSON config file')
  .option('--cwd <dir>', 'Working directory for the server process')
  .action(async (opts) => {
    const cfg = config.init(opts.config);

    const host = opts.host || cfg.host || '0.0.0.0';
    const port = parseInt(opts.port || cfg.port || '8000', 10);

    if (opts.cwd) {
      try {
        process.chdir(opts.cwd);
      } catch (err) {
        console.error(
          `Error: cannot change to directory '${opts.cwd}': ${err.message}`,
        );
        process.exit(1);
      }
    }

    try {
      const { startMcpServer } = await import('./mcp.js');
      await startMcpServer({ transport: opts.transport, host, port });
    } catch (err) {
      if (err.code === 'ERR_MODULE_NOT_FOUND') {
        console.error('Missing MCP dependencies. Install with:');
        console.error('  npm install @modelcontextprotocol/sdk');
        process.exit(1);
      }
      throw err;
    }
  });

program.parse();
