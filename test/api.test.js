/**
 * API endpoint tests.
 */

import {
  startTestServer,
  stopTestServer,
  getBaseUrl,
  authHeaders,
} from "./setup.js";
import fs from "fs/promises";
import path from "path";
import os from "os";

let baseUrl;
let testDir;
let testDirRelative;

beforeAll(async () => {
  baseUrl = await startTestServer();
  testDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "open-terminal-lite-test-"),
  );
  // API returns paths relative to USER_FS_DIR (os.tmpdir() in tests)
  testDirRelative = path.relative(os.tmpdir(), testDir);
});

afterAll(async () => {
  await stopTestServer();
  if (testDir) {
    await fs.rm(testDir, { recursive: true, force: true });
  }
});

describe("Health", () => {
  test("GET /health returns ok", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.status).toBe("ok");
  });
});

describe("Authentication", () => {
  test("Protected endpoints require API key", async () => {
    const res = await fetch(`${baseUrl}/files/list`);
    expect(res.status).toBe(401);
  });

  test("Invalid API key is rejected", async () => {
    const res = await fetch(`${baseUrl}/files/list`, {
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(res.status).toBe(401);
  });

  test("Valid API key is accepted", async () => {
    const res = await fetch(`${baseUrl}/files/list?directory=${testDir}`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
  });
});

describe("Files API", () => {
  describe("GET /files/list", () => {
    test("Lists directory contents", async () => {
      await fs.writeFile(path.join(testDir, "test.txt"), "hello");
      await fs.mkdir(path.join(testDir, "subdir"));

      const res = await fetch(`${baseUrl}/files/list?directory=${testDir}`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.dir).toBe(testDirRelative);
      expect(data.entries).toContainEqual(
        expect.objectContaining({
          name: "test.txt",
          type: "file",
        }),
      );
      expect(data.entries).toContainEqual(
        expect.objectContaining({
          name: "subdir",
          type: "directory",
        }),
      );
    });

    test("Returns 404 for non-existent directory", async () => {
      const res = await fetch(
        `${baseUrl}/files/list?directory=${testDir}/nonexistent`,
        {
          headers: authHeaders(),
        },
      );
      expect(res.status).toBe(404);
    });
  });

  describe("GET /files/read", () => {
    test("Reads file content", async () => {
      const filePath = path.join(testDir, "read-test.txt");
      const filePathRelative = path.join(testDirRelative, "read-test.txt");
      await fs.writeFile(filePath, "line1\nline2\nline3");

      const res = await fetch(`${baseUrl}/files/read?path=${filePath}`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.path).toBe(filePathRelative);
      expect(data.total_lines).toBe(3);
      expect(data.content).toBe("line1\nline2\nline3");
    });

    test("Reads file with line range", async () => {
      const filePath = path.join(testDir, "range-test.txt");
      await fs.writeFile(filePath, "line1\nline2\nline3\nline4\nline5");

      const res = await fetch(
        `${baseUrl}/files/read?path=${filePath}&start_line=2&end_line=4`,
        {
          headers: authHeaders(),
        },
      );
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.content).toBe("line2\nline3\nline4");
    });

    test("Returns 404 for non-existent file", async () => {
      const res = await fetch(
        `${baseUrl}/files/read?path=${testDir}/nonexistent.txt`,
        {
          headers: authHeaders(),
        },
      );
      expect(res.status).toBe(404);
    });
  });

  describe("POST /files/write", () => {
    test("Writes file content", async () => {
      const filePath = path.join(testDir, "write-test.txt");
      const filePathRelative = path.join(testDirRelative, "write-test.txt");

      const res = await fetch(`${baseUrl}/files/write`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ path: filePath, content: "hello world" }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.path).toBe(filePathRelative);
      expect(data.size).toBe(11);

      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("hello world");
    });

    test("Creates parent directories", async () => {
      const filePath = path.join(testDir, "nested", "dir", "file.txt");

      const res = await fetch(`${baseUrl}/files/write`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ path: filePath, content: "nested content" }),
      });
      expect(res.status).toBe(200);

      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("nested content");
    });
  });

  describe("DELETE /files/delete", () => {
    test("Deletes a file", async () => {
      const filePath = path.join(testDir, "delete-me.txt");
      await fs.writeFile(filePath, "to be deleted");

      const res = await fetch(`${baseUrl}/files/delete?path=${filePath}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);

      await expect(fs.access(filePath)).rejects.toThrow();
    });

    test("Deletes a directory", async () => {
      const dirPath = path.join(testDir, "delete-dir");
      await fs.mkdir(dirPath);
      await fs.writeFile(path.join(dirPath, "file.txt"), "content");

      const res = await fetch(`${baseUrl}/files/delete?path=${dirPath}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);

      await expect(fs.access(dirPath)).rejects.toThrow();
    });
  });

  describe("POST /files/replace", () => {
    test("Replaces content in file", async () => {
      const filePath = path.join(testDir, "replace-test.txt");
      await fs.writeFile(filePath, "hello world");

      const res = await fetch(`${baseUrl}/files/replace`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          path: filePath,
          replacements: [{ target: "world", replacement: "jest" }],
        }),
      });
      expect(res.status).toBe(200);

      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("hello jest");
    });

    test("Errors when target not found", async () => {
      const filePath = path.join(testDir, "replace-error.txt");
      await fs.writeFile(filePath, "hello world");

      const res = await fetch(`${baseUrl}/files/replace`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          path: filePath,
          replacements: [{ target: "nonexistent", replacement: "new" }],
        }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /files/grep", () => {
    test("Searches file contents", async () => {
      await fs.writeFile(path.join(testDir, "grep1.txt"), "foo bar baz");
      await fs.writeFile(path.join(testDir, "grep2.txt"), "hello world");
      await fs.writeFile(path.join(testDir, "grep3.txt"), "foo again");

      const res = await fetch(
        `${baseUrl}/files/grep?query=foo&path=${testDir}`,
        {
          headers: authHeaders(),
        },
      );
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.matches.length).toBe(2);
      expect(data.matches.map((m) => m.file)).toContain(
        path.join(testDirRelative, "grep1.txt"),
      );
      expect(data.matches.map((m) => m.file)).toContain(
        path.join(testDirRelative, "grep3.txt"),
      );
    });
  });

  describe("GET /files/glob", () => {
    test("Finds files by pattern", async () => {
      await fs.writeFile(path.join(testDir, "a.js"), "");
      await fs.writeFile(path.join(testDir, "b.js"), "");
      await fs.writeFile(path.join(testDir, "c.txt"), "");

      const res = await fetch(
        `${baseUrl}/files/glob?pattern=*.js&path=${testDir}`,
        {
          headers: authHeaders(),
        },
      );
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.matches.length).toBe(2);
      expect(data.matches.map((m) => m.path)).toContain("a.js");
      expect(data.matches.map((m) => m.path)).toContain("b.js");
    });
  });
});

describe("Execute API", () => {
  describe("POST /execute", () => {
    test("Executes command and returns output", async () => {
      const res = await fetch(`${baseUrl}/execute?wait=5`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ command: 'echo "hello from test"' }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.id).toBeDefined();
      expect(data.command).toBe('echo "hello from test"');
      expect(data.status).toBe("done");
      expect(data.exit_code).toBe(0);
      expect(data.output.some((o) => o.data.includes("hello from test"))).toBe(
        true,
      );
    });

    test("Returns process ID for background command", async () => {
      const res = await fetch(`${baseUrl}/execute`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ command: "sleep 0.1" }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.id).toBeDefined();
      expect(data.status).toBeDefined();
    });
  });

  describe("GET /execute", () => {
    test("Lists running processes", async () => {
      const res = await fetch(`${baseUrl}/execute`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
    });
  });

  describe("GET /execute/:id/status", () => {
    test("Gets process status", async () => {
      const execRes = await fetch(`${baseUrl}/execute?wait=5`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ command: 'echo "status test"' }),
      });
      const execData = await execRes.json();

      const res = await fetch(`${baseUrl}/execute/${execData.id}/status`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.id).toBe(execData.id);
      expect(data.status).toBe("done");
    });

    test("Returns 404 for non-existent process", async () => {
      const res = await fetch(`${baseUrl}/execute/nonexistent/status`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /execute/:id", () => {
    test("Kills a running process", async () => {
      const execRes = await fetch(`${baseUrl}/execute`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ command: "sleep 10" }),
      });
      expect(execRes.status).toBe(200);
      const execData = await execRes.json();
      expect(execData.id).toBeDefined();

      const res = await fetch(`${baseUrl}/execute/${execData.id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.status).toBe("killed");
    }, 15000);
  });
});

describe("Config API", () => {
  test("GET /api/config returns features", async () => {
    const res = await fetch(`${baseUrl}/api/config`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.features).toBeDefined();
    expect(typeof data.features.terminal).toBe("boolean");
  });
});
