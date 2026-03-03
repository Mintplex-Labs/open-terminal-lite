/**
 * Docker integration tests.
 *
 * Starts the actual Docker container and tests API operations
 * against bind-mounted test data.
 *
 * Run with: npm run test:docker
 */

import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");

const API_KEY = "docker-test-key";
const CONTAINER_PORT = 8765;
const CONTAINER_NAME = "open-terminal-lite-test";
const IMAGE_NAME = process.env.IMAGE_NAME || "open-terminal-lite:latest";

let baseUrl;

function authHeaders() {
  return {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  };
}

async function waitForHealthy(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) {
        const data = await res.json();
        if (data.status === "ok") return true;
      }
    } catch {
      // Container not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Container did not become healthy within ${timeoutMs}ms`);
}

function dockerRun() {
  // Kill any existing container with same name
  try {
    execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: "ignore" });
  } catch {
    // Ignore if doesn't exist
  }

  const args = [
    "run",
    "--rm",
    "-d",
    "--name",
    CONTAINER_NAME,
    "-p",
    `${CONTAINER_PORT}:8000`,
    "-v",
    `${DATA_DIR}:/home/sandbox/usrfs/data:ro`,
    "-e",
    `OPEN_TERMINAL_API_KEY=${API_KEY}`,
    IMAGE_NAME,
  ];

  const result = execSync(`docker ${args.join(" ")}`, { encoding: "utf-8" });
  return result.trim();
}

function dockerStop() {
  try {
    execSync(`docker stop ${CONTAINER_NAME}`, { stdio: "ignore" });
  } catch {
    // Ignore errors
  }
}

function dockerLogs() {
  try {
    return execSync(`docker logs ${CONTAINER_NAME}`, { encoding: "utf-8" });
  } catch {
    return "";
  }
}

beforeAll(async () => {
  // Check if image exists
  try {
    execSync(`docker image inspect ${IMAGE_NAME}`, { stdio: "ignore" });
  } catch {
    throw new Error(
      `Docker image "${IMAGE_NAME}" not found. Build it first with:\n` +
        `  docker build -t ${IMAGE_NAME} .`,
    );
  }

  dockerRun();
  baseUrl = `http://localhost:${CONTAINER_PORT}`;

  try {
    await waitForHealthy(baseUrl);
  } catch (err) {
    console.error("Container logs:", dockerLogs());
    dockerStop();
    throw err;
  }
}, 60000);

afterAll(() => {
  dockerStop();
});

describe("Docker Integration", () => {
  describe("Health", () => {
    test("container is healthy", async () => {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.status).toBe("ok");
    });
  });

  describe("Bind Mount - Read Operations", () => {
    test("can list bind-mounted data directory", async () => {
      const res = await fetch(`${baseUrl}/files/list?directory=data`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.entries).toContainEqual(
        expect.objectContaining({ name: "sample.txt", type: "file" }),
      );
      expect(data.entries).toContainEqual(
        expect.objectContaining({ name: "config.json", type: "file" }),
      );
    });

    test("can read bind-mounted text file", async () => {
      const res = await fetch(`${baseUrl}/files/read?path=data/sample.txt`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.content).toContain("Hello from the test data folder!");
    });

    test("can read bind-mounted JSON file", async () => {
      const res = await fetch(`${baseUrl}/files/read?path=data/config.json`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      const parsed = JSON.parse(data.content);
      expect(parsed.name).toBe("test-config");
      expect(parsed.settings.debug).toBe(true);
    });

    test("can read specific line range via execute", async () => {
      const res = await fetch(`${baseUrl}/execute?wait=5`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          command: 'sed -n "2,4p" ~/usrfs/data/sample.txt',
        }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      const output = data.output.map((o) => o.data).join("");
      expect(output).toContain("searchable content");
      expect(output).toContain("ERROR for grep testing");
      expect(output).not.toContain("Hello from");
    });
  });

  describe("Bind Mount - Grep Operations", () => {
    test("can grep for pattern in bind-mounted files", async () => {
      const res = await fetch(`${baseUrl}/execute?wait=5`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          command: "grep -r ERROR ~/usrfs/data/",
        }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.exit_code).toBe(0);

      const output = data.output.map((o) => o.data).join("");
      const matches = output
        .split("\n")
        .filter((line) => line.includes("ERROR"));
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    test("grep returns line numbers", async () => {
      const res = await fetch(`${baseUrl}/execute?wait=5`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          command: "grep -n ERROR ~/usrfs/data/sample.txt",
        }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.exit_code).toBe(0);

      const output = data.output.map((o) => o.data).join("");
      expect(output).toMatch(/3:.*ERROR/);
      expect(output).toMatch(/5:.*ERROR/);
    });

    test("grep with no matches returns empty", async () => {
      const res = await fetch(`${baseUrl}/execute?wait=5`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          command:
            "grep NONEXISTENT_STRING_12345 ~/usrfs/data/sample.txt || true",
        }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      const output = data.output
        .map((o) => o.data)
        .join("")
        .trim();
      expect(output).toBe("");
    });
  });

  describe("Bind Mount - Execute Commands", () => {
    test("can execute grep command on bind-mounted file", async () => {
      const res = await fetch(`${baseUrl}/execute?wait=5`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          command: "grep ERROR ~/usrfs/data/sample.txt",
        }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.status).toBe("done");
      expect(data.exit_code).toBe(0);

      const output = data.output.map((o) => o.data).join("");
      expect(output).toContain("ERROR");
    });

    test("can execute wc command on bind-mounted file", async () => {
      const res = await fetch(`${baseUrl}/execute?wait=5`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          command: "wc -l ~/usrfs/data/sample.txt",
        }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.status).toBe("done");
      expect(data.exit_code).toBe(0);

      const output = data.output.map((o) => o.data).join("");
      expect(output).toMatch(/\d/);
    });

    test("can pipe commands with bind-mounted file", async () => {
      const res = await fetch(`${baseUrl}/execute?wait=5`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          command: "cat ~/usrfs/data/sample.txt | grep -c ERROR",
        }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.status).toBe("done");
      expect(data.exit_code).toBe(0);

      const output = data.output
        .map((o) => o.data)
        .join("")
        .trim();
      expect(output).toBe("2");
    });

    test("can parse JSON with grep on bind-mounted file", async () => {
      const res = await fetch(`${baseUrl}/execute?wait=5`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          command: 'grep "timeout" ~/usrfs/data/config.json',
        }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.status).toBe("done");
      expect(data.exit_code).toBe(0);

      const output = data.output.map((o) => o.data).join("");
      expect(output).toContain("30");
    });
  });

  describe("Bind Mount - Read-Only Enforcement", () => {
    test("cannot write to read-only bind mount", async () => {
      const res = await fetch(`${baseUrl}/files/write`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          path: "data/should-fail.txt",
          content: "This should fail",
        }),
      });

      // Should fail - either 400 (path validation) or 500 (EROFS)
      expect(res.ok).toBe(false);
    });

    test("cannot delete from read-only bind mount", async () => {
      const res = await fetch(`${baseUrl}/files/delete?path=data/sample.txt`, {
        method: "DELETE",
        headers: authHeaders(),
      });

      // Should fail - either 400 (path validation) or 500 (EROFS)
      expect(res.ok).toBe(false);
    });
  });

  describe("Sandbox Volume - File Operations", () => {
    // Use absolute paths within sandbox home (same as Python tests)
    const testDir = "/home/sandbox/test-files";

    async function writeFile(filePath, content) {
      const res = await fetch(`${baseUrl}/files/write`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ path: filePath, content }),
      });
      return res;
    }

    afterAll(async () => {
      // Clean up test directory
      try {
        await fetch(`${baseUrl}/files/delete?path=${testDir}`, {
          method: "DELETE",
          headers: authHeaders(),
        });
      } catch {
        // Ignore cleanup errors
      }
    });

    describe("File Write", () => {
      test("can write file to sandbox volume", async () => {
        const content = "Hello from write test!\nLine 2\nLine 3";
        const res = await writeFile(`${testDir}/test-write.txt`, content);
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data.path).toContain("test-write.txt");
        expect(data.size).toBe(content.length);
      });

      test("can write file with different name", async () => {
        const res = await writeFile(
          `${testDir}/custom-name.txt`,
          "custom content",
        );
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data.path).toContain("custom-name.txt");
      });

      test("write creates nested directories", async () => {
        const nestedPath = `${testDir}/nested/deep/nested.txt`;
        const res = await writeFile(nestedPath, "nested content");
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data.path).toContain("nested.txt");
      });

      test("write requires path parameter", async () => {
        const res = await fetch(`${baseUrl}/files/write`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ content: "no path" }),
        });
        expect(res.status).toBe(400);

        const data = await res.json();
        expect(data.detail).toContain("path");
      });
    });

    describe("File Read", () => {
      const readTestFile = `${testDir}/read-test.txt`;
      const readTestContent =
        "Line 1: Hello\nLine 2: World\nLine 3: Test\nLine 4: Data\nLine 5: End";

      beforeAll(async () => {
        await writeFile(readTestFile, readTestContent);
      });

      test("can read written file", async () => {
        const res = await fetch(`${baseUrl}/files/read?path=${readTestFile}`, {
          headers: authHeaders(),
        });
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data.content).toBe(readTestContent);
      });

      test("can read file with line range", async () => {
        const res = await fetch(
          `${baseUrl}/files/read?path=${readTestFile}&start_line=2&end_line=4`,
          { headers: authHeaders() },
        );
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data.content).toContain("Line 2");
        expect(data.content).toContain("Line 3");
        expect(data.content).toContain("Line 4");
        expect(data.content).not.toContain("Line 1");
        expect(data.content).not.toContain("Line 5");
      });

      test("can read first line only", async () => {
        const res = await fetch(
          `${baseUrl}/files/read?path=${readTestFile}&start_line=1&end_line=1`,
          { headers: authHeaders() },
        );
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data.content).toContain("Line 1");
        expect(data.content).not.toContain("Line 2");
      });

      test("read returns 404 for non-existent file", async () => {
        const res = await fetch(
          `${baseUrl}/files/read?path=${testDir}/nonexistent.txt`,
          { headers: authHeaders() },
        );
        expect(res.status).toBe(404);
      });

      test("can list written files in directory", async () => {
        const res = await fetch(`${baseUrl}/files/list?directory=${testDir}`, {
          headers: authHeaders(),
        });
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data.entries).toContainEqual(
          expect.objectContaining({ name: "read-test.txt", type: "file" }),
        );
      });
    });

    describe("File Delete", () => {
      test("can delete written file", async () => {
        const deleteTestFile = `${testDir}/to-delete.txt`;

        // First write a file to delete
        const writeRes = await writeFile(deleteTestFile, "delete me");
        expect(writeRes.status).toBe(200);

        // Verify file exists
        const readRes = await fetch(
          `${baseUrl}/files/read?path=${deleteTestFile}`,
          { headers: authHeaders() },
        );
        expect(readRes.status).toBe(200);

        // Delete the file
        const deleteRes = await fetch(
          `${baseUrl}/files/delete?path=${deleteTestFile}`,
          {
            method: "DELETE",
            headers: authHeaders(),
          },
        );
        expect(deleteRes.status).toBe(200);

        const data = await deleteRes.json();
        expect(data.type).toBe("file");

        // Verify file is gone
        const verifyRes = await fetch(
          `${baseUrl}/files/read?path=${deleteTestFile}`,
          { headers: authHeaders() },
        );
        expect(verifyRes.status).toBe(404);
      });

      test("can delete directory recursively", async () => {
        const subDir = `${testDir}/sub-to-delete`;

        // Create a directory with files
        await writeFile(`${subDir}/file1.txt`, "file 1");
        await writeFile(`${subDir}/file2.txt`, "file 2");

        // Verify directory exists with files
        const listRes = await fetch(
          `${baseUrl}/files/list?directory=${subDir}`,
          { headers: authHeaders() },
        );
        expect(listRes.status).toBe(200);
        const listData = await listRes.json();
        expect(listData.entries.length).toBe(2);

        // Delete the directory
        const deleteRes = await fetch(
          `${baseUrl}/files/delete?path=${subDir}`,
          {
            method: "DELETE",
            headers: authHeaders(),
          },
        );
        expect(deleteRes.status).toBe(200);

        // Verify directory is gone
        const verifyRes = await fetch(
          `${baseUrl}/files/list?directory=${subDir}`,
          { headers: authHeaders() },
        );
        expect(verifyRes.status).toBe(404);
      });

      test("delete returns 404 for non-existent file", async () => {
        const res = await fetch(
          `${baseUrl}/files/delete?path=${testDir}/does-not-exist.txt`,
          {
            method: "DELETE",
            headers: authHeaders(),
          },
        );
        expect(res.status).toBe(404);
      });

      test("delete requires path parameter", async () => {
        const res = await fetch(`${baseUrl}/files/delete`, {
          method: "DELETE",
          headers: authHeaders(),
        });
        expect(res.status).toBe(400);

        const data = await res.json();
        expect(data.detail).toContain("path");
      });
    });

    describe("File Operations - Edge Cases", () => {
      test("can overwrite existing file", async () => {
        const filename = `${testDir}/overwrite-test.txt`;

        await writeFile(filename, "original content");

        // Overwrite with new content
        const writeRes = await writeFile(filename, "new content");
        expect(writeRes.status).toBe(200);

        // Verify new content
        const readRes = await fetch(`${baseUrl}/files/read?path=${filename}`, {
          headers: authHeaders(),
        });
        expect(readRes.status).toBe(200);

        const data = await readRes.json();
        expect(data.content).toBe("new content");
      });

      test("can write and read file with special characters in name", async () => {
        const filename = `${testDir}/file-with-dashes_and_underscores.txt`;

        const writeRes = await writeFile(filename, "special content");
        expect(writeRes.status).toBe(200);

        const readRes = await fetch(`${baseUrl}/files/read?path=${filename}`, {
          headers: authHeaders(),
        });
        expect(readRes.status).toBe(200);

        const data = await readRes.json();
        expect(data.content).toBe("special content");
      });

      test("can write empty file", async () => {
        const filename = `${testDir}/empty.txt`;

        const writeRes = await writeFile(filename, "");
        expect(writeRes.status).toBe(200);

        const data = await writeRes.json();
        expect(data.size).toBe(0);

        // Verify we can read it back
        const readRes = await fetch(`${baseUrl}/files/read?path=${filename}`, {
          headers: authHeaders(),
        });
        expect(readRes.status).toBe(200);

        const readData = await readRes.json();
        expect(readData.content).toBe("");
      });

      test("write to path outside sandbox fails", async () => {
        const res = await fetch(`${baseUrl}/files/write`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({
            path: "/tmp/escape.txt",
            content: "escape attempt",
          }),
        });

        expect(res.ok).toBe(false);
      });

      test("delete path outside sandbox fails", async () => {
        const res = await fetch(`${baseUrl}/files/delete?path=/etc/passwd`, {
          method: "DELETE",
          headers: authHeaders(),
        });

        expect(res.ok).toBe(false);
      });

      test("read path outside sandbox fails", async () => {
        const res = await fetch(`${baseUrl}/files/read?path=/etc/passwd`, {
          headers: authHeaders(),
        });

        expect(res.ok).toBe(false);
      });
    });
  });
});

// =============================================================================
// Fresh Volume Tests - Python Installation
// =============================================================================

describe("Fresh Volume - Python Installation", () => {
  const PYTHON_CONTAINER_NAME = "open-terminal-lite-test-python";
  const PYTHON_CONTAINER_PORT = 8766;
  const VOLUME_NAME = "open-terminal-lite-test-tools";
  let pythonBaseUrl;

  function dockerRunWithVolume(envVars = {}) {
    try {
      execSync(`docker rm -f ${PYTHON_CONTAINER_NAME}`, { stdio: "ignore" });
    } catch {
      // Ignore if doesn't exist
    }

    // Create a fresh volume
    try {
      execSync(`docker volume rm ${VOLUME_NAME}`, { stdio: "ignore" });
    } catch {
      // Ignore if doesn't exist
    }
    execSync(`docker volume create ${VOLUME_NAME}`);

    const envArgs = Object.entries(envVars)
      .map(([k, v]) => `-e ${k}=${v}`)
      .join(" ");

    const args = [
      "run",
      "--rm",
      "-d",
      "--name",
      PYTHON_CONTAINER_NAME,
      "-p",
      `${PYTHON_CONTAINER_PORT}:8000`,
      "-v",
      `${VOLUME_NAME}:/opt/tools`,
      "-e",
      `OPEN_TERMINAL_API_KEY=${API_KEY}`,
      envArgs,
      IMAGE_NAME,
    ].filter(Boolean);

    const result = execSync(`docker ${args.join(" ")}`, { encoding: "utf-8" });
    return result.trim();
  }

  function dockerStopPython() {
    try {
      execSync(`docker stop ${PYTHON_CONTAINER_NAME}`, { stdio: "ignore" });
    } catch {
      // Ignore errors
    }
    try {
      execSync(`docker volume rm ${VOLUME_NAME}`, { stdio: "ignore" });
    } catch {
      // Ignore errors
    }
  }

  function dockerLogsPython() {
    try {
      return execSync(`docker logs ${PYTHON_CONTAINER_NAME}`, {
        encoding: "utf-8",
      });
    } catch {
      return "";
    }
  }

  async function waitForToolsReady(url, timeoutMs = 180000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(`${url}/api/config`, {
          headers: authHeaders(),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.tools_ready) return true;
        }
      } catch {
        // Container not ready yet
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`Tools did not become ready within ${timeoutMs}ms`);
  }

  beforeAll(async () => {
    // Start container with Python installation
    dockerRunWithVolume({
      INSTALL_LANGUAGES: "python3,py3-pip",
      INSTALL_PIP: "requests",
    });
    pythonBaseUrl = `http://localhost:${PYTHON_CONTAINER_PORT}`;

    try {
      await waitForHealthy(pythonBaseUrl);
      console.log("Container healthy, waiting for Python installation...");
      await waitForToolsReady(pythonBaseUrl);
      console.log("Tools ready!");
    } catch (err) {
      console.error("Container logs:", dockerLogsPython());
      dockerStopPython();
      throw err;
    }
  }, 240000);

  afterAll(() => {
    dockerStopPython();
  });

  test("python3 is available", async () => {
    const res = await fetch(`${pythonBaseUrl}/execute?wait=10`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        command: "python3 --version",
      }),
    });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.status).toBe("done");
    expect(data.exit_code).toBe(0);

    const output = data.output.map((o) => o.data).join("");
    expect(output).toMatch(/Python 3\.\d+/);
  });

  test("pip packages are installed", async () => {
    const res = await fetch(`${pythonBaseUrl}/execute?wait=10`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        command: 'python3 -c "import requests; print(requests.__version__)"',
      }),
    });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.status).toBe("done");
    expect(data.exit_code).toBe(0);

    const output = data.output
      .map((o) => o.data)
      .join("")
      .trim();
    expect(output).toMatch(/^\d+\.\d+/);
  });

  test("can fetch example.com with python requests", async () => {
    const pythonScript = `
import requests
resp = requests.get('http://example.com', timeout=30)
print(f'Status: {resp.status_code}')
print(f'Contains Example Domain: {"Example Domain" in resp.text}')
`.trim();

    const res = await fetch(`${pythonBaseUrl}/execute?wait=30`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        command: `python3 -c "${pythonScript.replace(/"/g, '\\"')}"`,
      }),
    });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.status).toBe("done");
    expect(data.exit_code).toBe(0);

    const output = data.output.map((o) => o.data).join("");
    expect(output).toContain("Status: 200");
    expect(output).toContain("Contains Example Domain: True");
  });

  test("can run multi-line python script via file", async () => {
    // First write a Python script to the container
    const scriptContent = `#!/usr/bin/env python3
import requests
import json

def fetch_and_parse(url):
    response = requests.get(url, timeout=30)
    return {
        'status_code': response.status_code,
        'content_length': len(response.text),
        'has_doctype': '<!doctype' in response.text.lower(),
    }

result = fetch_and_parse('http://example.com')
print(json.dumps(result, indent=2))
`;

    // Write the script
    const writeRes = await fetch(`${pythonBaseUrl}/files/write`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        path: "/home/sandbox/fetch_example.py",
        content: scriptContent,
      }),
    });
    expect(writeRes.status).toBe(200);

    // Execute the script
    const execRes = await fetch(`${pythonBaseUrl}/execute?wait=30`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        command: "python3 /home/sandbox/fetch_example.py",
      }),
    });
    expect(execRes.status).toBe(200);

    const data = await execRes.json();
    expect(data.status).toBe("done");
    expect(data.exit_code).toBe(0);

    const output = data.output.map((o) => o.data).join("");
    const result = JSON.parse(output);
    expect(result.status_code).toBe(200);
    expect(result.content_length).toBeGreaterThan(100);
    expect(result.has_doctype).toBe(true);
  });

  test("can use urllib (stdlib) to fetch example.com", async () => {
    const pythonScript = `
import urllib.request
with urllib.request.urlopen('http://example.com', timeout=30) as response:
    html = response.read().decode('utf-8')
    print(f'Status: {response.status}')
    print(f'Title found: {"<title>" in html.lower()}')
`.trim();

    const res = await fetch(`${pythonBaseUrl}/execute?wait=30`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        command: `python3 -c "${pythonScript.replace(/"/g, '\\"')}"`,
      }),
    });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.status).toBe("done");
    expect(data.exit_code).toBe(0);

    const output = data.output.map((o) => o.data).join("");
    expect(output).toContain("Status: 200");
    expect(output).toContain("Title found: True");
  });
});
