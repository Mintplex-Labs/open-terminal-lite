/**
 * Core operation handlers shared between HTTP API and MCP.
 *
 * Each handler exports:
 * - schema: MCP tool definition (name, description, inputSchema)
 * - handler: async function(args, context) => result
 *
 * Context contains sandbox helpers and environment config.
 */

import fsp from 'fs/promises';
import path from 'path';
import mime from 'mime-types';
import crypto from 'crypto';
import { createRunner, PipeRunner } from './runner.js';

let pdfParse = null;
try {
  pdfParse = (await import('pdf-parse')).default;
} catch {
  // pdf-parse not available
}

/**
 * Helper: escape regex special characters
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Helper: simple glob matching
 */
function minimatch(filename, pattern) {
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexPattern}$`).test(filename);
}

// ---------------------------------------------------------------------------
// File Operations
// ---------------------------------------------------------------------------

export const getCwd = {
  schema: {
    name: 'get_cwd',
    description: 'Get the current working directory.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  async handler(_args, ctx) {
    const cwd = process.cwd();
    const relative = cwd.startsWith(ctx.userFsDir)
      ? path.relative(ctx.userFsDir, cwd) || '.'
      : '.';
    return { cwd: relative, absolute: cwd };
  },
};

export const setCwd = {
  schema: {
    name: 'set_cwd',
    description: 'Change the current working directory.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path to change to',
        },
      },
      required: ['path'],
    },
  },
  async handler(args, ctx) {
    const target = ctx.resolvePath(args.path);
    const stat = await fsp.stat(target);
    if (!stat.isDirectory()) {
      throw new Error('Directory not found');
    }
    process.chdir(target);
    const relative = path.relative(ctx.userFsDir, target) || '.';
    return { cwd: relative, absolute: target };
  },
};

export const listFiles = {
  schema: {
    name: 'list_files',
    description: 'List directory contents with detailed metadata (size, permissions, modification time). Similar to ls -la.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Directory path to list (default: current directory)',
        },
      },
    },
  },
  async handler(args, ctx) {
    const directory = args.directory || '.';
    const target = ctx.resolvePath(directory);

    const stat = await fsp.stat(target);
    if (!stat.isDirectory()) {
      throw new Error('Directory not found');
    }

    const names = await fsp.readdir(target);
    const entries = [];

    for (const name of names.sort()) {
      const fullPath = path.join(target, name);
      try {
        const fileStat = await fsp.stat(fullPath);
        entries.push({
          name,
          type: fileStat.isDirectory() ? 'directory' : 'file',
          size: fileStat.size,
          modified: fileStat.mtimeMs / 1000,
        });
      } catch {
        // Skip files we can't stat
      }
    }

    const relative = path.relative(ctx.userFsDir, target) || '.';
    return { dir: relative, entries };
  },
};

export const readFile = {
  schema: {
    name: 'read_file',
    description:
      'Read the contents of a file. Supports line ranges and PDF extraction.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file to read',
        },
        start_line: {
          type: 'number',
          description: 'First line to return (1-indexed)',
        },
        end_line: {
          type: 'number',
          description: 'Last line to return (1-indexed)',
        },
      },
      required: ['path'],
    },
  },
  async handler(args, ctx) {
    const target = ctx.resolvePath(args.path);
    const stat = await fsp.stat(target);
    if (!stat.isFile()) {
      throw new Error('File not found');
    }

    const relative = path.relative(ctx.userFsDir, target);
    const startLine = args.start_line || null;
    const endLine = args.end_line || null;

    // Try reading as text
    try {
      const content = await fsp.readFile(target, 'utf-8');
      const lines = content.split('\n');
      const start = (startLine || 1) - 1;
      const end = endLine || lines.length;

      return {
        path: relative,
        total_lines: lines.length,
        content: lines.slice(start, end).join('\n'),
      };
    } catch {
      // File is binary
      const mimeType = mime.lookup(target) || 'application/octet-stream';

      // Extract text from PDFs
      if (mimeType === 'application/pdf' && pdfParse) {
        const buffer = await fsp.readFile(target);
        const data = await pdfParse(buffer);
        const lines = data.text.split('\n');
        const start = (startLine || 1) - 1;
        const end = endLine || lines.length;

        return {
          path: relative,
          total_lines: lines.length,
          content: lines.slice(start, end).join('\n'),
        };
      }

      // Return info about binary file
      if (
        ctx.binaryMimePrefixes?.some((prefix) => mimeType.startsWith(prefix))
      ) {
        return {
          path: relative,
          binary: true,
          mime_type: mimeType,
          size: stat.size,
        };
      }

      throw new Error(`Unsupported binary file type: ${mimeType}`);
    }
  },
};

export const writeFile = {
  schema: {
    name: 'write_file',
    description:
      'Write text content to a file. Creates parent directories automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to write to',
        },
        content: {
          type: 'string',
          description: 'Text content to write',
        },
      },
      required: ['path', 'content'],
    },
  },
  async handler(args, ctx) {
    const target = ctx.resolvePath(args.path);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, args.content || '');
    const relative = path.relative(ctx.userFsDir, target);
    return { path: relative, size: Buffer.byteLength(args.content || '') };
  },
};

export const deleteFile = {
  schema: {
    name: 'delete_file',
    description: 'Delete a file or directory.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to delete',
        },
      },
      required: ['path'],
    },
  },
  async handler(args, ctx) {
    const target = ctx.resolvePath(args.path);

    if (target === ctx.userFsDir) {
      throw new Error('Cannot delete root directory');
    }

    const stat = await fsp.stat(target);
    const isDir = stat.isDirectory();

    if (isDir) {
      await fsp.rm(target, { recursive: true });
    } else {
      await fsp.unlink(target);
    }

    const relative = path.relative(ctx.userFsDir, target);
    return { path: relative, type: isDir ? 'directory' : 'file' };
  },
};

export const moveFile = {
  schema: {
    name: 'move_file',
    description: 'Move or rename a file or directory.',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'Source path',
        },
        destination: {
          type: 'string',
          description: 'Destination path',
        },
      },
      required: ['source', 'destination'],
    },
  },
  async handler(args, ctx) {
    const sourcePath = ctx.resolvePath(args.source);
    const destPath = ctx.resolvePath(args.destination);

    try {
      await fsp.stat(sourcePath);
    } catch {
      throw new Error('Source path not found');
    }

    const destDir = path.dirname(destPath);
    try {
      const dirStat = await fsp.stat(destDir);
      if (!dirStat.isDirectory()) {
        throw new Error('Destination parent directory not found');
      }
    } catch {
      throw new Error('Destination parent directory not found');
    }

    try {
      await fsp.stat(destPath);
      throw new Error('Destination already exists');
    } catch (err) {
      if (err.message === 'Destination already exists') throw err;
      // Good, destination doesn't exist
    }

    await fsp.rename(sourcePath, destPath);
    const relSource = path.relative(ctx.userFsDir, sourcePath);
    const relDest = path.relative(ctx.userFsDir, destPath);
    return { source: relSource, destination: relDest };
  },
};

export const mkdir = {
  schema: {
    name: 'mkdir',
    description: 'Create a directory (and parent directories if needed).',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path to create',
        },
      },
      required: ['path'],
    },
  },
  async handler(args, ctx) {
    const target = ctx.resolvePath(args.path);
    await fsp.mkdir(target, { recursive: true });
    const relative = path.relative(ctx.userFsDir, target);
    return { path: relative };
  },
};

export const replaceInFile = {
  schema: {
    name: 'replace_in_file',
    description: 'Find and replace exact strings in a file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file to modify',
        },
        replacements: {
          type: 'array',
          description: 'List of find-and-replace operations',
          items: {
            type: 'object',
            properties: {
              target: {
                type: 'string',
                description: 'Exact string to find',
              },
              replacement: {
                type: 'string',
                description: 'Content to replace the target with',
              },
              allow_multiple: {
                type: 'boolean',
                description: 'If true, replaces all occurrences',
              },
              start_line: {
                type: 'number',
                description:
                  'Limit search to lines starting from this line (1-indexed)',
              },
              end_line: {
                type: 'number',
                description:
                  'Limit search to lines up to this line (1-indexed)',
              },
            },
            required: ['target', 'replacement'],
          },
        },
      },
      required: ['path', 'replacements'],
    },
  },
  async handler(args, ctx) {
    const target = ctx.resolvePath(args.path);

    try {
      await fsp.stat(target);
    } catch {
      throw new Error('File not found');
    }

    let content = await fsp.readFile(target, 'utf-8');

    for (const chunk of args.replacements || []) {
      let searchRegion = content;
      let lines = null;
      let start = 0;
      let end = 0;

      if (chunk.start_line || chunk.end_line) {
        lines = content.split('\n');
        start = (chunk.start_line || 1) - 1;
        end = chunk.end_line || lines.length;
        searchRegion = lines.slice(start, end).join('\n');
      }

      const count = searchRegion.split(chunk.target).length - 1;
      if (count === 0) {
        throw new Error(
          `Target string not found: ${chunk.target.slice(0, 100)}`,
        );
      }
      if (count > 1 && !chunk.allow_multiple) {
        throw new Error(
          `Found ${count} occurrences but allow_multiple is false`,
        );
      }

      if (lines) {
        const newRegion = searchRegion
          .split(chunk.target)
          .join(chunk.replacement);
        lines.splice(start, end - start, newRegion);
        content = lines.join('\n');
      } else {
        content = content.split(chunk.target).join(chunk.replacement);
      }
    }

    await fsp.writeFile(target, content);
    const relative = path.relative(ctx.userFsDir, target);
    return { path: relative, size: Buffer.byteLength(content) };
  },
};

export const grepSearch = {
  schema: {
    name: 'grep_search',
    description: 'Search file contents for a text or regex pattern. Recursively searches directories. Returns matching lines with file paths and line numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text or regex pattern to search for',
        },
        path: {
          type: 'string',
          description:
            'Directory or file to search in (default: current directory)',
        },
        regex: {
          type: 'boolean',
          description: 'Treat query as a regex pattern',
        },
        case_insensitive: {
          type: 'boolean',
          description: 'Perform case-insensitive matching',
        },
        include: {
          type: 'string',
          description: 'Glob pattern to filter files (e.g. "*.js")',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of matches to return (default: 50)',
        },
      },
      required: ['query'],
    },
  },
  async handler(args, ctx) {
    const query = args.query;
    const searchPath = args.path || '.';
    const regex = args.regex;
    const caseInsensitive = args.case_insensitive;
    const include = args.include;
    const maxResults = Math.min(args.max_results || 50, 500);

    const target = ctx.resolvePath(searchPath);

    try {
      await fsp.stat(target);
    } catch {
      throw new Error('Search path not found');
    }

    const flags = caseInsensitive ? 'gi' : 'g';
    let pattern;
    try {
      pattern = regex
        ? new RegExp(query, flags)
        : new RegExp(escapeRegex(query), flags);
    } catch (err) {
      throw new Error(`Invalid regex: ${err.message}`);
    }

    const matches = [];
    let truncated = false;

    const includePatterns = include
      ? Array.isArray(include)
        ? include
        : [include]
      : null;

    const matchesInclude = (filename) => {
      if (!includePatterns) return true;
      return includePatterns.some((glob) => minimatch(filename, glob));
    };

    const searchFile = async (filePath) => {
      if (truncated) return;

      try {
        const content = await fsp.readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        const relPath = path.relative(ctx.userFsDir, filePath);

        for (let i = 0; i < lines.length; i++) {
          if (truncated) break;

          pattern.lastIndex = 0;
          if (pattern.test(lines[i])) {
            matches.push({
              file: relPath,
              line: i + 1,
              content: lines[i].replace(/[\r\n]+$/, ''),
            });
            if (matches.length >= maxResults) {
              truncated = true;
              return;
            }
          }
        }
      } catch {
        // Skip binary or unreadable files
      }
    };

    const stat = await fsp.stat(target);
    if (stat.isFile()) {
      await searchFile(target);
    } else {
      const walkDir = async (dir) => {
        if (truncated) return;

        const entries = await fsp.readdir(dir, { withFileTypes: true });
        for (const entry of entries.sort((a, b) =>
          a.name.localeCompare(b.name),
        )) {
          if (truncated) break;

          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walkDir(fullPath);
          } else if (entry.isFile() && matchesInclude(entry.name)) {
            await searchFile(fullPath);
          }
        }
      };
      await walkDir(target);
    }

    const relTarget = path.relative(ctx.userFsDir, target) || '.';
    return { query, path: relTarget, matches, truncated };
  },
};

export const globSearch = {
  schema: {
    name: 'glob_search',
    description:
      'Search for files and directories by name using glob patterns.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: "Glob pattern to match (e.g. '*.py', 'test_*.js')",
        },
        path: {
          type: 'string',
          description:
            'Directory to search within (default: current directory)',
        },
        type: {
          type: 'string',
          description: "Filter by type: 'file', 'directory', or 'any'",
          enum: ['file', 'directory', 'any'],
        },
        exclude: {
          type: 'string',
          description: 'Glob pattern to exclude from results',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of matches to return (default: 50)',
        },
      },
      required: ['pattern'],
    },
  },
  async handler(args, ctx) {
    const pattern = args.pattern;
    const searchPath = args.path || '.';
    const type = args.type || 'any';
    const exclude = args.exclude;
    const maxResults = Math.min(args.max_results || 50, 500);

    const target = ctx.resolvePath(searchPath);

    const stat = await fsp.stat(target);
    if (!stat.isDirectory()) {
      throw new Error('Search directory not found');
    }

    const excludePatterns = exclude
      ? Array.isArray(exclude)
        ? exclude
        : [exclude]
      : null;

    const matches = [];
    let truncated = false;

    const walkDir = async (dir) => {
      if (truncated) return;

      const entries = await fsp.readdir(dir, { withFileTypes: true });
      const items = [];

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(target, fullPath);

        if (
          type === 'any' ||
          (type === 'directory' && entry.isDirectory()) ||
          (type === 'file' && entry.isFile())
        ) {
          items.push({ entry, fullPath, relPath });
        }

        if (entry.isDirectory()) {
          items.push({ recurse: true, entry, fullPath });
        }
      }

      items.sort((a, b) => {
        if (a.recurse && !b.recurse) return 1;
        if (!a.recurse && b.recurse) return -1;
        return (a.entry?.name || '').localeCompare(b.entry?.name || '');
      });

      for (const item of items) {
        if (truncated) break;

        if (item.recurse) {
          await walkDir(item.fullPath);
          continue;
        }

        const { entry, fullPath, relPath } = item;

        // Check pattern match
        if (!minimatch(entry.name, pattern) && !minimatch(relPath, pattern)) {
          continue;
        }

        // Check exclusions
        if (
          excludePatterns &&
          excludePatterns.some(
            (excl) => minimatch(entry.name, excl) || minimatch(relPath, excl),
          )
        ) {
          continue;
        }

        try {
          const fileStat = await fsp.stat(fullPath);
          matches.push({
            path: relPath,
            type: entry.isDirectory() ? 'directory' : 'file',
            size: fileStat.size,
            modified: fileStat.mtimeMs / 1000,
          });

          if (matches.length >= maxResults) {
            truncated = true;
            break;
          }
        } catch {
          // Skip files we can't stat
        }
      }
    };

    await walkDir(target);

    const relTarget = path.relative(ctx.userFsDir, target) || '.';
    return { pattern, path: relTarget, matches, truncated };
  },
};

// ---------------------------------------------------------------------------
// Command Execution
// ---------------------------------------------------------------------------

const processes = new Map();
const EXPIRY_SECONDS = 300;

function cleanupExpired() {
  const now = Date.now();
  for (const [id, proc] of processes) {
    if (proc.finishedAt && now - proc.finishedAt > EXPIRY_SECONDS * 1000) {
      processes.delete(id);
    }
  }
}

export const listProcesses = {
  schema: {
    name: 'list_processes',
    description: 'List running and recently completed background processes started via run_command. Use this to check on long-running commands or retrieve their output.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  async handler(_args, _ctx) {
    cleanupExpired();
    const result = [];
    for (const proc of processes.values()) {
      result.push({
        id: proc.id,
        command: proc.command,
        status: proc.status,
        exit_code: proc.exitCode,
      });
    }
    return result;
  },
};

export const runCommand = {
  schema: {
    name: 'run_command',
    description:
      'Execute any shell command in a Linux environment. Use this to run system utilities (top, ps, htop, df, free, uname), programming languages (python, node, ruby), package managers (apt, apk, pip, npm), network tools (curl, wget, ping, netstat), file operations (ls, cat, grep, find), and any other CLI program. Returns immediately with process ID for long-running commands.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to execute (e.g., "top -b -n 1", "ps aux", "python script.py")',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the command',
        },
        env: {
          type: 'object',
          description: 'Additional environment variables',
        },
        wait: {
          type: 'number',
          description: 'Seconds to wait for completion (default: 30)',
        },
        tail: {
          type: 'number',
          description: 'Only return last N output entries',
        },
      },
      required: ['command'],
    },
  },
  async handler(args, ctx) {
    const { command, cwd, env: extraEnv, wait = 30, tail = null } = args;

    const subprocessEnv = extraEnv ? { ...process.env, ...extraEnv } : null;
    const runner = await createRunner(command, cwd, subprocessEnv);

    const processId = crypto.randomUUID().slice(0, 12);
    const logPath = path.join(ctx.logDir, 'processes', `${processId}.jsonl`);

    await fsp.mkdir(path.dirname(logPath), { recursive: true });

    const proc = {
      id: processId,
      command,
      runner,
      status: 'running',
      exitCode: null,
      finishedAt: null,
      logPath,
      output: [],
    };
    processes.set(processId, proc);

    // Create log file handle
    const logHandle = {
      _fd: null,
      async write(data) {
        if (!this._fd) {
          this._fd = await fsp.open(logPath, 'a');
        }
        await this._fd.write(data);
      },
      async close() {
        if (this._fd) {
          await this._fd.close();
          this._fd = null;
        }
      },
    };

    // Write start entry
    await logHandle.write(
      JSON.stringify({
        type: 'start',
        command,
        pid: runner.pid,
        ts: Date.now() / 1000,
      }) + '\n',
    );

    // Collect output in memory too
    const outputCollector = {
      async write(data) {
        const record = JSON.parse(data);
        if (['stdout', 'stderr', 'output'].includes(record.type)) {
          proc.output.push({ type: record.type, data: record.data });
        }
        await logHandle.write(data);
      },
    };

    // Start logging output
    const logTask = (async () => {
      try {
        await runner.readOutput(outputCollector);
      } finally {
        const exitCode = await runner.wait();
        proc.exitCode = exitCode;
        proc.status = 'done';
        proc.finishedAt = Date.now();
        runner.close();
        await logHandle.write(
          JSON.stringify({
            type: 'end',
            exit_code: exitCode,
            ts: Date.now() / 1000,
          }) + '\n',
        );
        await logHandle.close();
      }
    })();
    proc.logTask = logTask;

    // Wait if requested
    if (wait !== null && wait > 0) {
      await Promise.race([
        logTask,
        new Promise((resolve) => setTimeout(resolve, wait * 1000)),
      ]);
    }

    let entries = proc.output;
    let truncated = false;
    if (tail !== null && entries.length > tail) {
      entries = entries.slice(-tail);
      truncated = true;
    }

    return {
      id: processId,
      command,
      status: proc.status,
      exit_code: proc.exitCode,
      output: entries,
      truncated,
    };
  },
};

export const getProcessStatus = {
  schema: {
    name: 'get_process_status',
    description: 'Get the status, exit code, and stdout/stderr output of a background process started via run_command. Use this to retrieve results from long-running commands.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Process ID returned from run_command',
        },
        wait: {
          type: 'number',
          description: 'Seconds to wait for completion',
        },
        offset: {
          type: 'number',
          description: 'Start reading output from this index',
        },
        tail: {
          type: 'number',
          description: 'Only return last N output entries',
        },
      },
      required: ['id'],
    },
  },
  async handler(args, _ctx) {
    cleanupExpired();
    const proc = processes.get(args.id);
    if (!proc) {
      throw new Error('Process not found');
    }

    const wait = args.wait || 0;
    const offset = args.offset || 0;
    const tail = args.tail || null;

    if (wait > 0 && proc.status === 'running' && proc.logTask) {
      await Promise.race([
        proc.logTask,
        new Promise((resolve) => setTimeout(resolve, wait * 1000)),
      ]);
    }

    let entries = proc.output.slice(offset);
    let truncated = false;
    if (tail !== null && entries.length > tail) {
      entries = entries.slice(-tail);
      truncated = true;
    }

    return {
      id: proc.id,
      command: proc.command,
      status: proc.status,
      exit_code: proc.exitCode,
      output: entries,
      truncated,
      next_offset: proc.output.length,
    };
  },
};

export const sendProcessInput = {
  schema: {
    name: 'send_process_input',
    description: 'Send input to a running process.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Process ID',
        },
        input: {
          type: 'string',
          description: 'Input to send (supports escape sequences like \\n)',
        },
      },
      required: ['id', 'input'],
    },
  },
  async handler(args, _ctx) {
    cleanupExpired();
    const proc = processes.get(args.id);
    if (!proc) {
      throw new Error('Process not found');
    }

    if (proc.status !== 'running') {
      throw new Error('Process has already exited');
    }

    // Convert literal escape sequences
    let text = args.input;
    try {
      text = JSON.parse(`"${args.input.replace(/"/g, '\\"')}"`);
    } catch {
      // Use as-is
    }

    proc.runner.writeInput(text);
    if (proc.runner instanceof PipeRunner) {
      await proc.runner.drainInput();
    }

    return { status: 'ok' };
  },
};

export const killProcess = {
  schema: {
    name: 'kill_process',
    description: 'Kill a running process.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Process ID',
        },
        force: {
          type: 'boolean',
          description: 'Use SIGKILL instead of SIGTERM',
        },
      },
      required: ['id'],
    },
  },
  async handler(args, _ctx) {
    cleanupExpired();
    const proc = processes.get(args.id);
    if (!proc) {
      throw new Error('Process not found');
    }

    if (proc.status === 'running') {
      proc.runner.kill(args.force);
      const exitCode = await proc.runner.wait();
      proc.runner.close();
      proc.status = 'killed';
      proc.exitCode = exitCode;
    }

    processes.delete(args.id);
    return { status: 'killed' };
  },
};

// ---------------------------------------------------------------------------
// Export all handlers for easy iteration
// ---------------------------------------------------------------------------

export const allHandlers = {
  getCwd,
  setCwd,
  listFiles,
  readFile,
  writeFile,
  deleteFile,
  moveFile,
  mkdir,
  replaceInFile,
  grepSearch,
  globSearch,
  listProcesses,
  runCommand,
  getProcessStatus,
  sendProcessInput,
  killProcess,
};
