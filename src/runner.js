/**
 * Process runners for executing commands with PTY or pipe-based I/O.
 *
 * Provides a unified interface for running subprocesses via PTY (Unix/Windows)
 * or pipes (cross-platform fallback).
 */

import { spawn } from 'child_process';
import os from 'os';

let pty = null;
try {
  pty = await import('node-pty');
} catch {
  // node-pty not available (might need compilation)
}

/**
 * Abstract base class for process runners.
 */
class ProcessRunner {
  /**
   * Read output from the process and write entries to logFile.
   * @param {object|null} logFile - File handle with write() method
   */
  async readOutput(_logFile) {
    throw new Error('Not implemented');
  }

  /**
   * Send data to the process's stdin / PTY.
   * @param {Buffer|string} data - Data to write
   */
  writeInput(_data) {
    throw new Error('Not implemented');
  }

  /**
   * Terminate (SIGTERM) or kill (SIGKILL) the process.
   * @param {boolean} force - If true, use SIGKILL
   */
  kill(_force = false) {
    throw new Error('Not implemented');
  }

  /**
   * Wait for the process to exit and return the exit code.
   * @returns {Promise<number>} Exit code
   */
  async wait() {
    throw new Error('Not implemented');
  }

  /**
   * Release file descriptors and other resources.
   */
  close() {
    throw new Error('Not implemented');
  }

  /**
   * PID of the child process.
   * @returns {number}
   */
  get pid() {
    throw new Error('Not implemented');
  }
}

/**
 * Spawn a command under a pseudo-terminal using node-pty.
 */
export class PtyRunner extends ProcessRunner {
  constructor(command, cwd, env) {
    super();
    const shell =
      process.env.SHELL || (os.platform() === 'win32' ? 'cmd.exe' : '/bin/sh');
    const shellArgs =
      os.platform() === 'win32' ? ['/c', command] : ['-c', command];

    this._pty = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...env },
    });

    this._exitCode = null;
    this._exited = false;
    this._exitPromise = new Promise((resolve) => {
      this._pty.onExit(({ exitCode }) => {
        this._exitCode = exitCode;
        this._exited = true;
        resolve(exitCode);
      });
    });

    this._dataListeners = [];
    this._pendingWrites = [];
    this._outputBuffer = [];
    this._pty.onData((data) => {
      // Buffer all output immediately to avoid losing data from fast commands
      this._outputBuffer.push({ data, ts: Date.now() / 1000 });

      for (const listener of this._dataListeners) {
        const result = listener(data);
        if (result && typeof result.then === 'function') {
          this._pendingWrites.push(result);
          result.finally(() => {
            const idx = this._pendingWrites.indexOf(result);
            if (idx >= 0) this._pendingWrites.splice(idx, 1);
          });
        }
      }
    });
  }

  get pid() {
    return this._pty.pid;
  }

  async readOutput(logFile) {
    const handler = async (data) => {
      if (logFile) {
        const entry =
          JSON.stringify({
            type: 'output',
            data: data,
            ts: Date.now() / 1000,
          }) + '\n';
        await logFile.write(entry);
      }
    };

    // Atomically: capture buffered output, clear buffer, and register handler
    // This ensures no data is lost between buffer clear and handler registration
    const buffered = this._outputBuffer;
    this._outputBuffer = [];
    this._dataListeners.push(handler);

    // Now safely write any buffered output that arrived before readOutput was called
    if (logFile && buffered.length > 0) {
      for (const { data, ts } of buffered) {
        const entry =
          JSON.stringify({
            type: 'output',
            data: data,
            ts: ts,
          }) + '\n';
        await logFile.write(entry);
      }
    }

    return new Promise((resolve) => {
      this._exitPromise.then(async () => {
        // Allow event loop to process any remaining data events before we finish
        // Using setTimeout(0) ensures we run after I/O callbacks and setImmediate
        await new Promise((r) => setTimeout(r, 10));

        const idx = this._dataListeners.indexOf(handler);
        if (idx >= 0) this._dataListeners.splice(idx, 1);
        // Wait for any pending writes to complete before resolving
        if (this._pendingWrites.length > 0) {
          await Promise.all(this._pendingWrites);
        }
        resolve();
      });
    });
  }

  writeInput(data) {
    if (typeof data === 'string') {
      this._pty.write(data);
    } else {
      this._pty.write(data.toString());
    }
  }

  kill(force = false) {
    this._pty.kill(force ? 'SIGKILL' : 'SIGTERM');
  }

  async wait() {
    return this._exitPromise;
  }

  close() {
    // node-pty handles cleanup automatically
  }

  resize(cols, rows) {
    this._pty.resize(cols, rows);
  }
}

/**
 * Spawn a command with stdin/stdout/stderr pipes (cross-platform fallback).
 */
export class PipeRunner extends ProcessRunner {
  constructor(command, cwd, env) {
    super();
    this._command = command;
    this._cwd = cwd;
    this._env = env;
    this._process = null;
    this._exitCode = null;
    this._exitPromise = null;
    this._outputBuffer = [];
    this._streamsEnded = false;
    this._streamEndPromise = null;
  }

  async start() {
    const shell = os.platform() === 'win32' ? 'cmd.exe' : '/bin/sh';
    const shellArgs =
      os.platform() === 'win32' ? ['/c', this._command] : ['-c', this._command];

    this._process = spawn(shell, shellArgs, {
      cwd: this._cwd || process.cwd(),
      env: { ...process.env, ...this._env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this._exitPromise = new Promise((resolve) => {
      this._process.on('exit', (code) => {
        this._exitCode = code ?? 0;
        resolve(this._exitCode);
      });
    });

    // Start buffering output immediately to avoid losing data from fast commands
    let stdoutEnded = false;
    let stderrEnded = false;

    this._streamEndPromise = new Promise((resolve) => {
      const checkDone = () => {
        if (stdoutEnded && stderrEnded) {
          this._streamsEnded = true;
          resolve();
        }
      };

      this._process.stdout.on('data', (chunk) => {
        this._outputBuffer.push({
          type: 'stdout',
          data: chunk.toString(),
          ts: Date.now() / 1000,
        });
      });
      this._process.stdout.on('end', () => {
        stdoutEnded = true;
        checkDone();
      });

      this._process.stderr.on('data', (chunk) => {
        this._outputBuffer.push({
          type: 'stderr',
          data: chunk.toString(),
          ts: Date.now() / 1000,
        });
      });
      this._process.stderr.on('end', () => {
        stderrEnded = true;
        checkDone();
      });
    });
  }

  get pid() {
    return this._process?.pid;
  }

  async readOutput(logFile) {
    // Wait for streams to end
    await this._streamEndPromise;

    // Write buffered output to log file
    if (logFile) {
      for (const entry of this._outputBuffer) {
        await logFile.write(JSON.stringify(entry) + '\n');
      }
    }
  }

  writeInput(data) {
    if (this._process?.stdin && !this._process.stdin.destroyed) {
      this._process.stdin.write(data);
    }
  }

  async drainInput() {
    return new Promise((resolve) => {
      if (this._process?.stdin && !this._process.stdin.destroyed) {
        this._process.stdin.once('drain', resolve);
      } else {
        resolve();
      }
    });
  }

  kill(force = false) {
    if (this._process) {
      this._process.kill(force ? 'SIGKILL' : 'SIGTERM');
    }
  }

  async wait() {
    return this._exitPromise;
  }

  close() {
    // Pipes are cleaned up automatically
  }
}

/**
 * Factory: create a PTY runner if available, or fall back to pipe runner.
 *
 * @param {string} command - Shell command to execute
 * @param {string|null} cwd - Working directory
 * @param {object|null} env - Additional environment variables
 * @returns {Promise<ProcessRunner>} A process runner instance
 */
export async function createRunner(command, cwd, env) {
  if (pty) {
    try {
      return new PtyRunner(command, cwd, env);
    } catch {
      // Fall back to pipes if PTY fails
    }
  }

  const runner = new PipeRunner(command, cwd, env);
  await runner.start();
  return runner;
}

/**
 * Check if PTY support is available.
 * @returns {boolean}
 */
export function isPtyAvailable() {
  return pty !== null;
}
