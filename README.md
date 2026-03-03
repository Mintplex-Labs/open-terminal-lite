# ⚡ Open-Terminal-Lite

A lightweight, self-hosted terminal that gives AI agents a dedicated environment to run commands, manage files, and execute code — all through a simple API.

> **This is a fork of [open-webui/open-terminal](https://github.com/open-webui/open-terminal)**, rebuilt from the ground up in Node.js for lightweight, multi-user deployments in [AnythingLLM](https://anythingllm.com) and other AI tools.

## Why Open-Terminal-Lite?

The original Open Terminal is excellent, but ships with a quite large container footprint containing Python, data science libraries, and lots of other things. For many use cases — especially multi-tenant deployments — this is overkill for simple shell execution or where an admin wants to restrict what a container can or cannot do - regardless of sandboxing.

**Open-Terminal-Lite** is a complete rewrite that:

- Ships as a **~400MB base image** (10x smaller)
- Lightweight Alpine base image.
- Supports **on-demand tool installation** via environment flags
- Provides **volume-based sandboxing** for multi-user isolation
- Includes built-in **MCP (Model Context Protocol)** support

## Key Differences from Original

| Feature | Open Terminal | Open-Terminal-Lite |
|---------|---------------|-------------------|
| Image Size | ~4GB | ~400MB |
| Runtime | Python (FastAPI) | Node.js (Express) |
| Pre-installed Tools | Everything | Minimal (install on demand) |
| Multi-user Sandboxing | Requires enterprise | Built-in via volumes |
| MCP Support | Separate package | Built-in |
| Configuration | TOML files | Environment variables & JSON |

## Getting Started

### Docker (recommended)

```bash
docker run -d \
  --name open-terminal-lite \
  --restart unless-stopped \
  -p 8000:8000 \
  -v open-terminal-data:/home/sandbox \
  -e OPEN_TERMINAL_API_KEY=your-secret-key \
  ghcr.io/mintplex-labs/open-terminal-lite
```

That's it — you're up and running at `http://localhost:8000`.

> **Tip:** If you don't set an API key, one is generated automatically. Grab it with `docker logs open-terminal-lite`.

### Container Resource Limits

For production deployments, administrators can constrain container resources using Docker's built-in resource flags. This prevents any single container from consuming excessive CPU or memory on the host machine:

```bash
docker run -d --name open-terminal-lite \
  --memory="512m" \
  --memory-swap="512m" \
  --cpus="1.0" \
  --pids-limit=100 \
  -p 8000:8000 \
  -e OPEN_TERMINAL_API_KEY=your-secret-key \
  ghcr.io/mintplex-labs/open-terminal-lite
```

**Example: Restrictive profile for untrusted workloads**
```bash
docker run -d --name terminal-restricted \
  --memory="256m" \
  --memory-swap="256m" \
  --cpus="0.5" \
  --pids-limit=50 \ # Limit the number of processes that can run in the container (prevent fork bombs, abuse)
  --read-only \
  -v terminal-data:/home/sandbox \
  ghcr.io/mintplex-labs/open-terminal-lite
```

**Example: High-resource profile for data science**
```bash
docker run -d --name terminal-datascience \
  --memory="4g" \
  --cpus="4.0" \
  --pids-limit=500 \
  -e INSTALL_SCIENCE=true \
  ghcr.io/mintplex-labs/open-terminal-lite
```

## Configuration

Open-Terminal-Lite is configured entirely via environment variables:

### Core Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `OPEN_TERMINAL_API_KEY` | API key for authentication. Supports `_FILE` suffix for Docker secrets. | Auto-generated |
| `OPEN_TERMINAL_CORS_ALLOWED_ORIGINS` | Comma-separated list of allowed CORS origins | `*` |
| `OPEN_TERMINAL_LOG_DIR` | Directory for process logs | `~/.local/state/open-terminal/logs` |
| `OPEN_TERMINAL_MAX_SESSIONS` | Maximum concurrent terminal sessions | `16` |
| `OPEN_TERMINAL_ENABLE_TERMINAL` | Enable interactive terminal feature | `true` |
| `SHOW_DOCS` | Show Swagger API documentation at `/docs` | `false` |

### Sandbox Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `OPEN_TERMINAL_SANDBOX_HOME` | Outer boundary for file operations | User home directory |
| `OPEN_TERMINAL_USER_FS_DIR` | Root directory for user file operations | `~/usrfs` |
| `TOOLS_VOLUME` | Directory for installed tools | `/opt/tools` |

### Install Flags

Install additional tools at container startup. Set to `true` for defaults or provide a comma-separated list of specific packages.

| Flag | Default Packages | Description |
|------|------------------|-------------|
| `INSTALL_ALL` | - | Enable all install flags below |
| `INSTALL_EDITORS` | vim, neovim, nano | Text editors |
| `INSTALL_LANGUAGES` | python3, py3-pip, ruby, perl, lua5.4, rust, cargo, go | Programming languages |
| `INSTALL_DATA` | jq, yq, xmlstarlet, sqlite | Data processing tools |
| `INSTALL_MEDIA` | imagemagick, graphicsmagick, pandoc, poppler-utils, ghostscript | Media processing |
| `INSTALL_COMPRESSION` | bzip2, xz, zstd, p7zip, lz4 | Compression utilities |
| `INSTALL_SCIENCE` | numpy, pandas, scipy, scikit-learn, matplotlib, seaborn, plotly, jupyter | Python data science |
| `INSTALL_DB` | postgresql-client, mysql-client, redis | Database clients |
| `INSTALL_CLOUD` | awscli (+ azure-cli if `all` or `azure`) | Cloud CLI tools |
| `INSTALL_KUBERNETES` | kubectl, helm, k9s | Kubernetes tools |
| `INSTALL_PYTHON` | requests, httpx, click, python-dotenv, watchdog, python-dateutil, loguru, typer, pydantic | Python scripting packages |
| `INSTALL_APK` | - | Custom Alpine packages (comma-separated) |
| `INSTALL_PIP` | - | Custom pip packages (comma-separated) |
| `INSTALL_NPM` | - | Custom npm packages (comma-separated) |

**Example: Data science workbench**
```bash
docker run -d \
  -e INSTALL_SCIENCE=true \
  -e INSTALL_DATA=true \
  ghcr.io/mintplex-labs/open-terminal-lite
```

**Example: Custom packages only**
```bash
docker run -d \
  -e INSTALL_APK="ffmpeg,git-lfs" \
  -e INSTALL_PIP="openai,langchain" \
  ghcr.io/mintplex-labs/open-terminal-lite
```

> **Note:** Tools are installed in the background. The API returns `503 Service Unavailable` for command execution until installation completes. Check status via `GET /api/config`.

## API Reference

To see all available endpoints, run the container with `SHOW_DOCS=true` and visit `http://localhost:8000/docs`.

## MCP (Model Context Protocol) Integration

Open-Terminal-Lite includes a built-in MCP server for use with MCP-compatible applications.

### Basic Setup

```json
{
  "mcpServers": {
    "open-terminal": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "--memory=512m",
        "--cpus=1.0",
        "--pids-limit=100",
        "-v", "my-sandbox:/home/sandbox/usrfs",
        "-v", "my-tools:/opt/tools",
        // "-e", "INSTALL_PYTHON=true", // see INSTALL_FLAGS above for more options
        "ghcr.io/mintplex-labs/open-terminal-lite",
        "mcp"
      ]
    }
  }
}
```

### Custom Image (skip package installation)

If you always need certain packages, build a custom image with them pre-installed for instant startup:

```dockerfile
FROM ghcr.io/mintplex-labs/open-terminal-lite
RUN apk add --no-cache python3 py3-pip
```

```bash
docker build -t my-terminal .
```

Then use `my-terminal` instead of `ghcr.io/mintplex-labs/open-terminal-lite` in your MCP config

## Docker Secrets Support

For sensitive values like API keys, Open-Terminal-Lite supports Docker secrets via the `_FILE` suffix pattern:

```bash
# Create secret
echo "my-secret-api-key" | docker secret create terminal_api_key -

# Use in service
docker service create \
  --name open-terminal-lite \
  --secret terminal_api_key \
  -e OPEN_TERMINAL_API_KEY_FILE=/run/secrets/terminal_api_key \
  ghcr.io/mintplex-labs/open-terminal-lite
```

## Building from Source

```bash
git clone https://github.com/Mintplex-Labs/open-terminal-lite.git
cd open-terminal-lite
npm install
npm start
```

### Running Tests

```bash
# Unit tests
npm test

# Docker integration tests
npm run test:docker
```

### Building the Docker Image

```bash
docker build -t open-terminal-lite .
```

## License

MIT — see [LICENSE](LICENSE) for details.

---

<p align="center">
  <a href="https://github.com/Mintplex-Labs/open-terminal-lite">Mintplex-Labs/open-terminal-lite</a> · 
  A lightweight fork of <a href="https://github.com/open-webui/open-terminal">open-webui/open-terminal</a>
</p>
