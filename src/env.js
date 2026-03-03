/**
 * Environment variable resolution with Docker-secrets support.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import * as config from './config.js';

/**
 * Resolve an environment variable with Docker-secrets `_FILE` support.
 *
 * If `<var>_FILE` is set, its value is treated as a path whose contents
 * supply the variable's value (trailing whitespace is stripped). Setting
 * both `<var>` and `<var>_FILE` is an error.
 *
 * This follows the convention established by the official PostgreSQL Docker
 * image (see https://hub.docker.com/_/postgres#docker-secrets).
 *
 * @param {string} varName - The environment variable name
 * @param {string} defaultValue - Default value if not set
 * @returns {string} The resolved value
 */
function resolveFileEnv(varName, defaultValue = '') {
  const value = process.env[varName];
  const filePath = process.env[`${varName}_FILE`];

  if (value && filePath) {
    throw new Error(
      `Both ${varName} and ${varName}_FILE are set, but they are mutually exclusive.`,
    );
  }

  if (filePath) {
    return fs.readFileSync(filePath, 'utf-8').trim();
  }

  return value || defaultValue;
}

// API key with Docker secrets support
export let API_KEY = resolveFileEnv(
  'OPEN_TERMINAL_API_KEY',
  config.get('api_key', ''),
);

// CORS allowed origins
export const CORS_ALLOWED_ORIGINS =
  process.env.OPEN_TERMINAL_CORS_ALLOWED_ORIGINS ||
  config.get('cors_allowed_origins', '*');

// Log directory
export const LOG_DIR =
  process.env.OPEN_TERMINAL_LOG_DIR ||
  config.get(
    'log_dir',
    path.join(
      process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'),
      'open-terminal-lite',
      'logs',
    ),
  );

// Comma-separated mime type prefixes for binary files that read_file will return
// as raw binary responses (e.g. "image,audio" or "image/png,image/jpeg").
export const BINARY_FILE_MIME_PREFIXES = (
  process.env.OPEN_TERMINAL_BINARY_MIME_PREFIXES ||
  config.get('binary_mime_prefixes', 'image')
)
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean);

// Maximum number of terminal sessions
export const MAX_TERMINAL_SESSIONS = parseInt(
  process.env.OPEN_TERMINAL_MAX_SESSIONS ||
    config.get('max_terminal_sessions', '16'),
  10,
);

// Whether terminal feature is enabled
export const ENABLE_TERMINAL = !['false', '0', 'no'].includes(
  (
    process.env.OPEN_TERMINAL_ENABLE_TERMINAL ||
    String(config.get('enable_terminal', true))
  ).toLowerCase(),
);

// Terminal TERM environment variable
export const TERMINAL_TERM =
  process.env.OPEN_TERMINAL_TERM || config.get('term', 'xterm-256color');

// Whether to show Swagger API documentation at /docs
export const SHOW_DOCS = ['true', '1', 'yes'].includes(
  (process.env.SHOW_DOCS || config.get('show_docs', 'false')).toLowerCase(),
);

// Tools volume directory (for background-installed tools)
export const TOOLS_DIR =
  process.env.TOOLS_VOLUME || config.get('tools_dir', '/opt/tools');

// Ready marker file path
export const TOOLS_READY_MARKER = path.join(TOOLS_DIR, '.ready');

// Sandbox home directory (outer boundary for file operations)
export const SANDBOX_HOME_DIR =
  process.env.OPEN_TERMINAL_SANDBOX_HOME ||
  config.get('sandbox_home', os.homedir());

// User filesystem directory (sandboxed area for host<>container file transfers)
export const USER_FS_DIR =
  process.env.OPEN_TERMINAL_USER_FS_DIR ||
  config.get('user_fs_dir', path.join(os.homedir(), 'usrfs'));

/**
 * Update the API key at runtime (used by CLI to set generated key).
 * @param {string} key - The new API key
 */
export function setApiKey(key) {
  API_KEY = key;
}
