/**
 * Main Express API server for Open Terminal.
 *
 * Routes delegate to shared handlers for 1:1 parity with MCP tools.
 */

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import mime from 'mime-types';
import multer from 'multer';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import * as env from './env.js';
import * as handlers from './handlers.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const __filename = fileURLToPath(import.meta.url);

let pty = null;
try {
  pty = await import('node-pty');
} catch {
  // node-pty not available
}

const upload = multer({ storage: multer.memoryStorage() });

// Terminal sessions (not in handlers since they're WebSocket-based)
const terminalSessions = new Map();

/**
 * Swagger/OpenAPI configuration
 */
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Open Terminal API',
      version: pkg.version,
      description: 'Terminal interaction API providing file operations, command execution, and interactive terminal sessions.',
    },
    servers: [
      { url: '/', description: 'Current server' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
        },
      },
    },
    security: [{ bearerAuth: [] }],
  },
  apis: [__filename],
};

/**
 * Create the execution context for handlers.
 */
function createContext() {
  // Read sandbox paths at runtime to support test overrides
  const userFsDir = path.resolve(
    process.env.OPEN_TERMINAL_USER_FS_DIR || env.USER_FS_DIR,
  );
  const sandboxHomeDir = path.resolve(
    process.env.OPEN_TERMINAL_SANDBOX_HOME || env.SANDBOX_HOME_DIR,
  );

  return {
    userFsDir,
    sandboxHomeDir,
    logDir: process.env.OPEN_TERMINAL_LOG_DIR || env.LOG_DIR,
    binaryMimePrefixes: env.BINARY_FILE_MIME_PREFIXES,

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

      if (!resolved.startsWith(sandboxHomeDir + path.sep) && resolved !== sandboxHomeDir) {
        throw new Error('Path escapes sandbox');
      }

      return resolved;
    },
  };
}

/**
 * Wrap a handler call with error handling for HTTP responses.
 */
function wrapHandler(handler, ctx) {
  return async (req, res, args) => {
    try {
      const result = await handler(args, ctx);
      res.json(result);
    } catch (err) {
      if (err.message === 'Path escapes sandbox') {
        return res.status(400).json({ detail: 'Path escapes sandbox' });
      }
      if (err.code === 'ENOENT') {
        return res.status(404).json({ detail: 'File or directory not found' });
      }
      if (err.message === 'File not found' || err.message === 'Directory not found') {
        return res.status(404).json({ detail: err.message });
      }
      if (err.message === 'Process not found') {
        return res.status(404).json({ detail: err.message });
      }
      if (err.message === 'Source path not found' || err.message === 'Search path not found') {
        return res.status(404).json({ detail: err.message });
      }
      res.status(400).json({ detail: err.message });
    }
  };
}

/**
 * Create and configure the Express app.
 */
export function createApp() {
  const app = express();
  const ctx = createContext();

  // CORS middleware
  const corsOrigins = env.CORS_ALLOWED_ORIGINS.split(',').map(s => s.trim());
  app.use(cors({
    origin: corsOrigins.includes('*') ? '*' : corsOrigins,
    credentials: true,
  }));

  app.use(express.json());

  // Normalize null query params
  app.use((req, res, next) => {
    for (const key of Object.keys(req.query)) {
      if (req.query[key] === 'null') {
        delete req.query[key];
      }
    }
    next();
  });

  // Authentication middleware
  const authenticate = (req, res, next) => {
    if (!env.API_KEY) return next();
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ') || auth.slice(7) !== env.API_KEY) {
      return res.status(401).json({ detail: 'Invalid API key' });
    }
    next();
  };

  // Tools ready check middleware
  const requireToolsReady = (req, res, next) => {
    // Read TOOLS_VOLUME at runtime to support test overrides
    const toolsDir = process.env.TOOLS_VOLUME || env.TOOLS_DIR;
    const readyMarker = path.join(toolsDir, '.ready');
    if (!fs.existsSync(readyMarker)) {
      return res.status(503).json({
        detail: 'Tools are still being installed. Please wait and try again.',
        retry_after: 10,
      });
    }
    next();
  };

  // Ensure user filesystem directory exists
  fs.mkdirSync(env.USER_FS_DIR, { recursive: true });

  // ---------------------------------------------------------------------------
  // Swagger Docs
  // ---------------------------------------------------------------------------

  if (env.SHOW_DOCS) {
    const swaggerSpec = swaggerJsdoc(swaggerOptions);
    app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
      customCss: '.swagger-ui .topbar { display: none }',
      customSiteTitle: 'Open Terminal API Docs',
    }));
    app.get('/openapi.json', (req, res) => res.json(swaggerSpec));
  } else {
    app.use('/docs', (req, res) => res.status(403).send('endpoint documentation is disabled'));
    app.get('/openapi.json', (req, res) => res.status(403).send('endpoint documentation is disabled'));
  }

  // ---------------------------------------------------------------------------
  // Health & Config
  // ---------------------------------------------------------------------------

  /**
   * @openapi
   * /:
   *   get:
   *     summary: Heartbeat
   *     tags: [Health]
   *     security: []
   *     responses:
   *       200:
   *         description: OK
   */
  app.get('/', (req, res) => {
    res.sendStatus(200);
  });

  /**
   * @openapi
   * /health:
   *   get:
   *     summary: Health check
   *     tags: [Health]
   *     security: []
   *     responses:
   *       200:
   *         description: Server is healthy
   */
  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  /**
   * @openapi
   * /api/config:
   *   get:
   *     summary: Get server configuration
   *     tags: [Config]
   *     security: []
   *     responses:
   *       200:
   *         description: Server configuration
   */
  app.get('/api/config', (req, res) => {
    res.json({
      features: {
        terminal: env.ENABLE_TERMINAL,
      },
      tools_ready: fs.existsSync(env.TOOLS_READY_MARKER),
    });
  });

  // ---------------------------------------------------------------------------
  // Files - Using shared handlers
  // ---------------------------------------------------------------------------

  /**
   * @openapi
   * /files/cwd:
   *   get:
   *     summary: Get current working directory
   *     tags: [Files]
   *     responses:
   *       200:
   *         description: Current working directory
   *   post:
   *     summary: Change current working directory
   *     tags: [Files]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [path]
   *             properties:
   *               path:
   *                 type: string
   *     responses:
   *       200:
   *         description: New working directory
   */
  app.get('/files/cwd', authenticate, async (req, res) => {
    await wrapHandler(handlers.getCwd.handler, ctx)(req, res, {});
  });

  app.post('/files/cwd', authenticate, async (req, res) => {
    await wrapHandler(handlers.setCwd.handler, ctx)(req, res, { path: req.body.path });
  });

  /**
   * @openapi
   * /files/list:
   *   get:
   *     summary: List directory contents
   *     tags: [Files]
   *     parameters:
   *       - in: query
   *         name: directory
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Directory listing
   */
  app.get('/files/list', authenticate, async (req, res) => {
    await wrapHandler(handlers.listFiles.handler, ctx)(req, res, {
      directory: req.query.directory,
    });
  });

  /**
   * @openapi
   * /files/read:
   *   get:
   *     summary: Read file contents
   *     tags: [Files]
   *     parameters:
   *       - in: query
   *         name: path
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: start_line
   *         schema:
   *           type: integer
   *       - in: query
   *         name: end_line
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: File contents
   */
  app.get('/files/read', authenticate, async (req, res) => {
    if (!req.query.path) {
      return res.status(400).json({ detail: 'path parameter required' });
    }

    try {
      const result = await handlers.readFile.handler({
        path: req.query.path,
        start_line: req.query.start_line ? parseInt(req.query.start_line, 10) : null,
        end_line: req.query.end_line ? parseInt(req.query.end_line, 10) : null,
      }, ctx);

      // Handle binary file response
      if (result.binary) {
        const target = ctx.resolvePath(req.query.path);
        const raw = await fsp.readFile(target);
        res.set('Content-Type', result.mime_type);
        return res.send(raw);
      }

      res.json(result);
    } catch (err) {
      if (err.message === 'Path escapes sandbox') {
        return res.status(400).json({ detail: 'Path escapes sandbox' });
      }
      if (err.code === 'ENOENT' || err.message === 'File not found') {
        return res.status(404).json({ detail: 'File not found' });
      }
      if (err.message.startsWith('Unsupported binary')) {
        return res.status(415).json({ detail: err.message });
      }
      res.status(400).json({ detail: err.message });
    }
  });

  // Display and view endpoints for binary files (HTTP-specific)
  app.get('/files/display', authenticate, async (req, res) => {
    const filePath = req.query.path;
    if (!filePath) {
      return res.status(400).json({ detail: 'path parameter required' });
    }

    try {
      const target = ctx.resolvePath(filePath);
      let exists = false;
      try {
        const stat = await fsp.stat(target);
        exists = stat.isFile();
      } catch {
        exists = false;
      }

      const relative = path.relative(ctx.userFsDir, target);
      res.json({ path: relative, exists });
    } catch (err) {
      if (err.message === 'Path escapes sandbox') {
        return res.status(400).json({ detail: 'Path escapes sandbox' });
      }
      res.status(400).json({ detail: err.message });
    }
  });

  app.get('/files/view', authenticate, async (req, res) => {
    const filePath = req.query.path;
    if (!filePath) {
      return res.status(400).json({ detail: 'path parameter required' });
    }

    try {
      const target = ctx.resolvePath(filePath);
      const stat = await fsp.stat(target);
      if (!stat.isFile()) {
        return res.status(404).json({ detail: 'File not found' });
      }

      const mimeType = mime.lookup(target) || 'application/octet-stream';
      const raw = await fsp.readFile(target);
      res.set('Content-Type', mimeType);
      res.send(raw);
    } catch (err) {
      if (err.message === 'Path escapes sandbox') {
        return res.status(400).json({ detail: 'Path escapes sandbox' });
      }
      if (err.code === 'ENOENT') {
        return res.status(404).json({ detail: 'File not found' });
      }
      res.status(400).json({ detail: err.message });
    }
  });

  /**
   * @openapi
   * /files/download:
   *   get:
   *     summary: Download a file
   *     tags: [Files]
   *     parameters:
   *       - in: query
   *         name: path
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: File content
   */
  app.get('/files/download', authenticate, async (req, res) => {
    const filePath = req.query.path;
    if (!filePath) {
      return res.status(400).json({ detail: 'path parameter required' });
    }

    try {
      const target = ctx.resolvePath(filePath);
      const stat = await fsp.stat(target);

      if (stat.isDirectory()) {
        return res.status(400).json({ detail: 'Cannot download a directory' });
      }

      const mimeType = mime.lookup(target) || 'application/octet-stream';
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(target)}"`);
      res.setHeader('Content-Length', stat.size);

      const stream = fs.createReadStream(target);
      stream.pipe(res);
    } catch (err) {
      if (err.message === 'Path escapes sandbox') {
        return res.status(400).json({ detail: 'Path escapes sandbox' });
      }
      if (err.code === 'ENOENT') {
        return res.status(404).json({ detail: 'File not found' });
      }
      res.status(400).json({ detail: err.message });
    }
  });

  /**
   * @openapi
   * /files/write:
   *   post:
   *     summary: Write content to a file
   *     tags: [Files]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [path]
   *             properties:
   *               path:
   *                 type: string
   *               content:
   *                 type: string
   *     responses:
   *       200:
   *         description: File written
   */
  app.post('/files/write', authenticate, async (req, res) => {
    if (!req.body.path) {
      return res.status(400).json({ detail: 'path required' });
    }
    await wrapHandler(handlers.writeFile.handler, ctx)(req, res, {
      path: req.body.path,
      content: req.body.content,
    });
  });

  /**
   * @openapi
   * /files/mkdir:
   *   post:
   *     summary: Create a directory
   *     tags: [Files]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [path]
   *             properties:
   *               path:
   *                 type: string
   *     responses:
   *       200:
   *         description: Directory created
   */
  app.post('/files/mkdir', authenticate, async (req, res) => {
    if (!req.body.path) {
      return res.status(400).json({ detail: 'path required' });
    }
    await wrapHandler(handlers.mkdir.handler, ctx)(req, res, { path: req.body.path });
  });

  /**
   * @openapi
   * /files/delete:
   *   delete:
   *     summary: Delete a file or directory
   *     tags: [Files]
   *     parameters:
   *       - in: query
   *         name: path
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Deleted
   */
  app.delete('/files/delete', authenticate, async (req, res) => {
    if (!req.query.path) {
      return res.status(400).json({ detail: 'path parameter required' });
    }
    await wrapHandler(handlers.deleteFile.handler, ctx)(req, res, { path: req.query.path });
  });

  /**
   * @openapi
   * /files/move:
   *   post:
   *     summary: Move or rename a file
   *     tags: [Files]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [source, destination]
   *             properties:
   *               source:
   *                 type: string
   *               destination:
   *                 type: string
   *     responses:
   *       200:
   *         description: Moved
   */
  app.post('/files/move', authenticate, async (req, res) => {
    if (!req.body.source || !req.body.destination) {
      return res.status(400).json({ detail: 'source and destination required' });
    }

    try {
      const result = await handlers.moveFile.handler({
        source: req.body.source,
        destination: req.body.destination,
      }, ctx);
      res.json(result);
    } catch (err) {
      if (err.message === 'Path escapes sandbox') {
        return res.status(400).json({ detail: 'Path escapes sandbox' });
      }
      if (err.message === 'Destination already exists') {
        return res.status(409).json({ detail: err.message });
      }
      if (err.message.includes('not found')) {
        return res.status(404).json({ detail: err.message });
      }
      res.status(400).json({ detail: err.message });
    }
  });

  /**
   * @openapi
   * /files/replace:
   *   post:
   *     summary: Find and replace in a file
   *     tags: [Files]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [path, replacements]
   *             properties:
   *               path:
   *                 type: string
   *               replacements:
   *                 type: array
   *     responses:
   *       200:
   *         description: Replaced
   */
  app.post('/files/replace', authenticate, async (req, res) => {
    if (!req.body.path) {
      return res.status(400).json({ detail: 'path required' });
    }
    await wrapHandler(handlers.replaceInFile.handler, ctx)(req, res, {
      path: req.body.path,
      replacements: req.body.replacements,
    });
  });

  /**
   * @openapi
   * /files/grep:
   *   get:
   *     summary: Search file contents
   *     tags: [Files]
   *     parameters:
   *       - in: query
   *         name: query
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: path
   *         schema:
   *           type: string
   *       - in: query
   *         name: regex
   *         schema:
   *           type: boolean
   *       - in: query
   *         name: case_insensitive
   *         schema:
   *           type: boolean
   *       - in: query
   *         name: include
   *         schema:
   *           type: string
   *       - in: query
   *         name: max_results
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: Search results
   */
  app.get('/files/grep', authenticate, async (req, res) => {
    if (!req.query.query) {
      return res.status(400).json({ detail: 'query parameter required' });
    }
    await wrapHandler(handlers.grepSearch.handler, ctx)(req, res, {
      query: req.query.query,
      path: req.query.path,
      regex: req.query.regex === 'true',
      case_insensitive: req.query.case_insensitive === 'true',
      include: req.query.include,
      max_results: req.query.max_results ? parseInt(req.query.max_results, 10) : undefined,
    });
  });

  /**
   * @openapi
   * /files/glob:
   *   get:
   *     summary: Search for files by name pattern
   *     tags: [Files]
   *     parameters:
   *       - in: query
   *         name: pattern
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: path
   *         schema:
   *           type: string
   *       - in: query
   *         name: type
   *         schema:
   *           type: string
   *           enum: [file, directory, any]
   *       - in: query
   *         name: exclude
   *         schema:
   *           type: string
   *       - in: query
   *         name: max_results
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: Matching files
   */
  app.get('/files/glob', authenticate, async (req, res) => {
    if (!req.query.pattern) {
      return res.status(400).json({ detail: 'pattern parameter required' });
    }
    await wrapHandler(handlers.globSearch.handler, ctx)(req, res, {
      pattern: req.query.pattern,
      path: req.query.path,
      type: req.query.type,
      exclude: req.query.exclude,
      max_results: req.query.max_results ? parseInt(req.query.max_results, 10) : undefined,
    });
  });

  // Upload endpoint (HTTP-specific, handles multipart)
  app.post('/files/upload', authenticate, upload.single('file'), async (req, res) => {
    const directory = req.query.directory;
    const url = req.query.url;

    if (!directory) {
      return res.status(400).json({ detail: 'directory parameter required' });
    }

    let content;
    let filename;

    if (url) {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        content = Buffer.from(await response.arrayBuffer());
        const urlPath = new URL(url).pathname;
        filename = path.basename(urlPath) || 'download';
      } catch (err) {
        return res.status(400).json({ detail: `Failed to fetch URL: ${err.message}` });
      }
    } else if (req.file) {
      content = req.file.buffer;
      filename = req.file.originalname || 'upload';
    } else {
      return res.status(400).json({ detail: "Provide either 'url' or a file upload." });
    }

    try {
      const targetDir = ctx.resolvePath(directory);
      await fsp.mkdir(targetDir, { recursive: true });
      const filePath = path.join(targetDir, filename);

      if (!filePath.startsWith(ctx.userFsDir + path.sep) && filePath !== ctx.userFsDir) {
        return res.status(400).json({ detail: 'Path escapes sandbox' });
      }

      await fsp.writeFile(filePath, content);
      const relative = path.relative(ctx.userFsDir, filePath);
      res.json({ path: relative, size: content.length });
    } catch (err) {
      if (err.message === 'Path escapes sandbox') {
        return res.status(400).json({ detail: 'Path escapes sandbox' });
      }
      res.status(400).json({ detail: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // Execute - Using shared handlers
  // ---------------------------------------------------------------------------

  /**
   * @openapi
   * /execute:
   *   get:
   *     summary: List running processes
   *     tags: [Execute]
   *     responses:
   *       200:
   *         description: List of processes
   *   post:
   *     summary: Execute a shell command
   *     tags: [Execute]
   *     parameters:
   *       - in: query
   *         name: wait
   *         schema:
   *           type: number
   *       - in: query
   *         name: tail
   *         schema:
   *           type: integer
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [command]
   *             properties:
   *               command:
   *                 type: string
   *               cwd:
   *                 type: string
   *               env:
   *                 type: object
   *     responses:
   *       200:
   *         description: Command result
   */
  app.get('/execute', authenticate, async (req, res) => {
    await wrapHandler(handlers.listProcesses.handler, ctx)(req, res, {});
  });

  app.post('/execute', authenticate, requireToolsReady, async (req, res) => {
    if (!req.body.command) {
      return res.status(400).json({ detail: 'command required' });
    }
    await wrapHandler(handlers.runCommand.handler, ctx)(req, res, {
      command: req.body.command,
      cwd: req.body.cwd,
      env: req.body.env,
      wait: req.query.wait ? parseFloat(req.query.wait) : 30,
      tail: req.query.tail ? parseInt(req.query.tail, 10) : null,
    });
  });

  /**
   * @openapi
   * /execute/{processId}/status:
   *   get:
   *     summary: Get process status
   *     tags: [Execute]
   *     parameters:
   *       - in: path
   *         name: processId
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: wait
   *         schema:
   *           type: number
   *       - in: query
   *         name: offset
   *         schema:
   *           type: integer
   *       - in: query
   *         name: tail
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: Process status
   */
  app.get('/execute/:processId/status', authenticate, async (req, res) => {
    await wrapHandler(handlers.getProcessStatus.handler, ctx)(req, res, {
      id: req.params.processId,
      wait: req.query.wait ? parseFloat(req.query.wait) : 0,
      offset: req.query.offset ? parseInt(req.query.offset, 10) : 0,
      tail: req.query.tail ? parseInt(req.query.tail, 10) : null,
    });
  });

  /**
   * @openapi
   * /execute/{processId}/input:
   *   post:
   *     summary: Send input to process
   *     tags: [Execute]
   *     parameters:
   *       - in: path
   *         name: processId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [input]
   *             properties:
   *               input:
   *                 type: string
   *     responses:
   *       200:
   *         description: Input sent
   */
  app.post('/execute/:processId/input', authenticate, async (req, res) => {
    await wrapHandler(handlers.sendProcessInput.handler, ctx)(req, res, {
      id: req.params.processId,
      input: req.body.input,
    });
  });

  /**
   * @openapi
   * /execute/{processId}:
   *   delete:
   *     summary: Kill a process
   *     tags: [Execute]
   *     parameters:
   *       - in: path
   *         name: processId
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: force
   *         schema:
   *           type: boolean
   *     responses:
   *       200:
   *         description: Process killed
   */
  app.delete('/execute/:processId', authenticate, async (req, res) => {
    await wrapHandler(handlers.killProcess.handler, ctx)(req, res, {
      id: req.params.processId,
      force: req.query.force === 'true',
    });
  });

  // ---------------------------------------------------------------------------
  // Terminal Sessions (WebSocket-based, not in shared handlers)
  // ---------------------------------------------------------------------------

  if (env.ENABLE_TERMINAL && pty) {
    function cleanupTerminalSession(sessionId) {
      const session = terminalSessions.get(sessionId);
      if (!session) return;

      terminalSessions.delete(sessionId);

      if (session.pty) {
        session.pty.kill();
      }
    }

    function isSessionAlive(session) {
      try {
        process.kill(session.pty.pid, 0);
        return true;
      } catch {
        return false;
      }
    }

    /**
     * @openapi
     * /api/terminals:
     *   post:
     *     summary: Create terminal session
     *     tags: [Terminals]
     *     responses:
     *       200:
     *         description: Session created
     *   get:
     *     summary: List terminal sessions
     *     tags: [Terminals]
     *     responses:
     *       200:
     *         description: List of sessions
     */
    app.post('/api/terminals', authenticate, requireToolsReady, (req, res) => {
      for (const [sid, session] of terminalSessions) {
        if (!isSessionAlive(session)) {
          cleanupTerminalSession(sid);
        }
      }

      if (terminalSessions.size >= env.MAX_TERMINAL_SESSIONS) {
        return res.status(429).json({
          error: `Maximum number of terminal sessions (${env.MAX_TERMINAL_SESSIONS}) reached`,
        });
      }

      const sessionId = crypto.randomUUID().slice(0, 8);
      const shell = process.env.SHELL || (os.platform() === 'win32' ? 'cmd.exe' : '/bin/sh');

      const spawnEnv = { ...process.env };
      spawnEnv.TERM = env.TERMINAL_TERM;

      const ptyProcess = pty.spawn(shell, [], {
        name: env.TERMINAL_TERM,
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: spawnEnv,
      });

      const session = {
        id: sessionId,
        pty: ptyProcess,
        createdAt: new Date().toISOString(),
        pid: ptyProcess.pid,
      };

      terminalSessions.set(sessionId, session);

      res.json({
        id: sessionId,
        created_at: session.createdAt,
        pid: session.pid,
      });
    });

    app.get('/api/terminals', authenticate, (req, res) => {
      const result = [];
      const toRemove = [];

      for (const [sid, session] of terminalSessions) {
        if (!isSessionAlive(session)) {
          toRemove.push(sid);
          continue;
        }
        result.push({
          id: sid,
          created_at: session.createdAt,
          pid: session.pid,
        });
      }

      for (const sid of toRemove) {
        cleanupTerminalSession(sid);
      }

      res.json(result);
    });

    /**
     * @openapi
     * /api/terminals/{sessionId}:
     *   get:
     *     summary: Get terminal session
     *     tags: [Terminals]
     *     parameters:
     *       - in: path
     *         name: sessionId
     *         required: true
     *         schema:
     *           type: string
     *     responses:
     *       200:
     *         description: Session info
     *   delete:
     *     summary: Delete terminal session
     *     tags: [Terminals]
     *     parameters:
     *       - in: path
     *         name: sessionId
     *         required: true
     *         schema:
     *           type: string
     *     responses:
     *       200:
     *         description: Session deleted
     */
    app.get('/api/terminals/:sessionId', authenticate, (req, res) => {
      const { sessionId } = req.params;
      const session = terminalSessions.get(sessionId);

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (!isSessionAlive(session)) {
        cleanupTerminalSession(sessionId);
        return res.status(404).json({ error: 'Session not found' });
      }

      res.json({
        id: sessionId,
        created_at: session.createdAt,
        pid: session.pid,
      });
    });

    app.delete('/api/terminals/:sessionId', authenticate, (req, res) => {
      const { sessionId } = req.params;

      if (!terminalSessions.has(sessionId)) {
        return res.status(404).json({ error: 'Session not found' });
      }

      cleanupTerminalSession(sessionId);
      res.json({ status: 'deleted' });
    });
  }

  return app;
}

/**
 * Start the server with WebSocket support for terminals.
 */
export async function startServer({ host, port, apiKey }) {
  if (apiKey) {
    env.setApiKey(apiKey);
    process.env.OPEN_TERMINAL_API_KEY = apiKey;
  }

  // Ensure the userFsDir exists (similar to entrypoint.sh setup)
  const userFsDir = path.resolve(
    process.env.OPEN_TERMINAL_USER_FS_DIR || env.USER_FS_DIR,
  );
  await fsp.mkdir(userFsDir, { recursive: true });

  const app = createApp();
  const server = createServer(app);

  if (env.ENABLE_TERMINAL && pty) {
    const wss = new WebSocketServer({ server, path: '/api/terminals' });

    wss.on('connection', async (ws, req) => {
      const urlParts = req.url.split('/');
      const sessionId = urlParts[urlParts.length - 1].split('?')[0];

      if (!sessionId || sessionId === 'terminals') {
        ws.close(4004, 'Session ID required');
        return;
      }

      const session = terminalSessions.get(sessionId);
      if (!session) {
        ws.close(4004, 'Session not found');
        return;
      }

      if (env.API_KEY) {
        try {
          const authPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timeout')), 10000);
            ws.once('message', (data) => {
              clearTimeout(timeout);
              try {
                const payload = JSON.parse(data.toString());
                if (payload.type === 'auth' && payload.token === env.API_KEY) {
                  resolve();
                } else {
                  reject(new Error('Invalid API key'));
                }
              } catch (err) {
                reject(err);
              }
            });
          });

          await authPromise;
        } catch {
          ws.close(4001, 'Auth failed');
          return;
        }
      }

      const dataHandler = session.pty.onData((data) => {
        if (ws.readyState === 1) {
          ws.send(data);
        }
      });

      ws.on('message', (data, isBinary) => {
        if (isBinary || Buffer.isBuffer(data)) {
          session.pty.write(data.toString());
        } else {
          try {
            const payload = JSON.parse(data.toString());
            if (payload.type === 'resize' && payload.cols && payload.rows) {
              session.pty.resize(payload.cols, payload.rows);
            }
          } catch {
            // Ignore invalid JSON
          }
        }
      });

      ws.on('close', () => {
        dataHandler.dispose();
      });

      ws.on('error', () => {
        dataHandler.dispose();
      });
    });
  }

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      console.log(`Server running at http://${host}:${port}`);
      resolve(server);
    });
  });
}
