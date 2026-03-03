/**
 * JSON configuration file support.
 *
 * Settings are resolved with this precedence (highest wins):
 *
 * 1. CLI flags
 * 2. Environment variables / Docker-secrets `_FILE` variants
 * 3. User config — `$XDG_CONFIG_HOME/open-terminal-lite/config.json`
 *    (defaults to `~/.config/open-terminal-lite/config.json`)
 * 4. System config — `/etc/open-terminal-lite/config.json`
 * 5. Built-in defaults
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const SYSTEM_CONFIG_PATH = '/etc/open-terminal-lite/config.json';

function getDefaultUserConfigPath() {
  const xdgConfig =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdgConfig, 'open-terminal-lite', 'config.json');
}

/**
 * Load and merge JSON configuration files.
 *
 * @param {string|null} explicitPath - If given, this file replaces the user-level lookup.
 *                                     The system-level config is still loaded underneath.
 * @returns {object} Merged configuration dictionary. System values are overridden
 *                   by user (or explicit) values.
 */
export function loadConfig(explicitPath = null) {
  let merged = {};

  // 1. System config (lowest priority of the two files)
  if (fs.existsSync(SYSTEM_CONFIG_PATH)) {
    try {
      const content = fs.readFileSync(SYSTEM_CONFIG_PATH, 'utf-8');
      merged = { ...merged, ...JSON.parse(content) };
    } catch (err) {
      console.error(
        `Warning: failed to read ${SYSTEM_CONFIG_PATH}: ${err.message}`,
      );
    }
  }

  // 2. User / explicit config (overrides system)
  const userPath = explicitPath || getDefaultUserConfigPath();
  if (fs.existsSync(userPath)) {
    try {
      const content = fs.readFileSync(userPath, 'utf-8');
      merged = { ...merged, ...JSON.parse(content) };
    } catch (err) {
      // If the user explicitly asked for this file, treat errors as fatal.
      if (explicitPath) {
        console.error(`Error: failed to read ${userPath}: ${err.message}`);
        process.exit(1);
      }
      console.error(`Warning: failed to read ${userPath}: ${err.message}`);
    }
  }

  return merged;
}

// Module-level merged config, lazily populated by init().
let _config = {};

/**
 * Load config files and cache the result module-wide.
 *
 * This should be called once, early in startup (e.g. from the CLI
 * entry-point), before env.js constants are evaluated.
 *
 * @param {string|null} explicitPath - Optional path to config file
 * @returns {object} The loaded configuration
 */
export function init(explicitPath = null) {
  _config = loadConfig(explicitPath);
  return _config;
}

/**
 * Look up a value from the loaded config.
 *
 * @param {string} key - The config key to look up
 * @param {*} defaultValue - Default value if key not found
 * @returns {*} The config value or default
 */
export function get(key, defaultValue = undefined) {
  return _config[key] !== undefined ? _config[key] : defaultValue;
}
