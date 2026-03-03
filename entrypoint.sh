#!/bin/bash
set -e

# ============================================================================
# TOOLS VOLUME CONFIGURATION
# ============================================================================
TOOLS_DIR="${TOOLS_VOLUME:-/opt/tools}"
MANIFEST="$TOOLS_DIR/.manifest"
INSTALL_LOG="$TOOLS_DIR/.install.log"
APK_LOCK="$TOOLS_DIR/.apk.lock"
READY_MARKER="$TOOLS_DIR/.ready"
PATHS_FILE="$TOOLS_DIR/.paths"

# ============================================================================
# DOCKER SECRETS SUPPORT
# ============================================================================
file_env() {
    local var="$1"
    local fileVar="${var}_FILE"
    local def="${2:-}"
    if [ "${!var:-}" ] && [ "${!fileVar:-}" ]; then
        printf >&2 'error: both %s and %s are set (but are exclusive)\n' "$var" "$fileVar"
        exit 1
    fi
    local val="$def"
    if [ "${!var:-}" ]; then
        val="${!var}"
    elif [ "${!fileVar:-}" ]; then
        val="$(< "${!fileVar}")"
    fi
    export "$var"="$val"
    unset "$fileVar"
}

file_env 'OPEN_TERMINAL_API_KEY'

# ============================================================================
# FIX HOME DIRECTORY PERMISSIONS
# ============================================================================
CURRENT_USER=$(whoami)
HOME_DIR="/home/$CURRENT_USER"
OWNER=$(stat -c '%U' "$HOME_DIR" 2>/dev/null || echo "$CURRENT_USER")
if [ "$OWNER" != "$CURRENT_USER" ]; then
    sudo chown -R "$CURRENT_USER:$CURRENT_USER" "$HOME_DIR" 2>/dev/null || true
fi

# ============================================================================
# TOOLS VOLUME SETUP
# ============================================================================
sudo mkdir -p "$TOOLS_DIR/bin" "$TOOLS_DIR/python" "$TOOLS_DIR/node"
sudo chown -R "$CURRENT_USER:$CURRENT_USER" "$TOOLS_DIR" 2>/dev/null || true
touch "$MANIFEST" "$APK_LOCK" "$PATHS_FILE"

# ============================================================================
# USER FILESYSTEM SETUP (sandboxed area for host<>container file transfers)
# ============================================================================
USER_FS_DIR="${OPEN_TERMINAL_USER_FS_DIR:-$HOME_DIR/usrfs}"
mkdir -p "$USER_FS_DIR"
# Fix ownership if mounted volume has wrong permissions (e.g., root-owned Docker volume)
sudo chown "$CURRENT_USER:$CURRENT_USER" "$USER_FS_DIR" 2>/dev/null || true
echo "=== User filesystem: $USER_FS_DIR ==="

export PATH="$TOOLS_DIR/bin:$PATH"
export PYTHONPATH="$TOOLS_DIR/python:$PYTHONPATH"
export NODE_PATH="$TOOLS_DIR/node/lib/node_modules:$NODE_PATH"

# Reload any saved PATH modifications from previous container runs
if [ -f "$PATHS_FILE" ]; then
    echo "=== Reloading saved PATH from $PATHS_FILE ==="
    source "$PATHS_FILE"
fi

# ============================================================================
# INSTALLATION HELPERS (used by background jobs)
# ============================================================================

is_installed() {
    grep -q "^$1$" "$MANIFEST" 2>/dev/null
}

mark_installed() {
    flock "$MANIFEST" -c "echo '$1' >> '$MANIFEST'"
}

log_install() {
    echo "[$(date '+%H:%M:%S')] $1" >> "$INSTALL_LOG"
    echo "[install] $1"
}

save_path() {
    # Save current PATH/PYTHONPATH/NODE_PATH to the tools volume for persistence
    flock "$PATHS_FILE" -c "cat > '$PATHS_FILE'" << PATHEOF
export PATH="$PATH"
export PYTHONPATH="$PYTHONPATH"
export NODE_PATH="$NODE_PATH"
PATHEOF
}

is_apk_actually_installed() {
    # Check if an APK package is actually installed in the system (not just in manifest)
    # This handles container restarts where APK packages are lost but manifest persists
    apk info -e "$1" >/dev/null 2>&1
}

install_apk() {
    local pkg=$1
    # Check both manifest AND actual installation - APK packages don't persist across container restarts
    if is_installed "apk:$pkg" && is_apk_actually_installed "$pkg"; then
        return 0
    fi
    log_install "apk: $pkg"
    flock "$APK_LOCK" sudo apk add --no-cache "$pkg" 2>&1 || {
        echo "[warn] Failed to install apk:$pkg" >> "$INSTALL_LOG"
        return 0
    }
    mark_installed "apk:$pkg"
    # Save PATH after APK install in case it added new paths
    save_path
}

install_pip() {
    local pkg=$1
    if ! is_installed "pip:$pkg"; then
        log_install "pip: $pkg"
        # Use timeout to prevent indefinite hangs, prefer binary wheels, --upgrade to handle existing packages
        timeout 300 pip install --quiet --prefer-binary --upgrade --target="$TOOLS_DIR/python" "$pkg" 2>&1 || {
            echo "[warn] Failed to install pip:$pkg" >> "$INSTALL_LOG"
            return 0
        }
        mark_installed "pip:$pkg"
        save_path
    fi
}

install_npm() {
    local pkg=$1
    if ! is_installed "npm:$pkg"; then
        log_install "npm: $pkg"
        npm install -g --prefix="$TOOLS_DIR/node" "$pkg" 2>&1 || {
            echo "[warn] Failed to install npm:$pkg" >> "$INSTALL_LOG"
            return 0
        }
        mark_installed "npm:$pkg"
        save_path
    fi
}

parse_list() {
    local value=$1
    local defaults=$2
    if [ "$value" = "true" ] || [ "$value" = "1" ]; then
        echo "$defaults"
    elif [ -n "$value" ] && [ "$value" != "false" ] && [ "$value" != "0" ]; then
        echo "$value" | tr ',' ' '
    fi
}

# Export functions and vars for subshells
export TOOLS_DIR MANIFEST INSTALL_LOG APK_LOCK READY_MARKER PATHS_FILE
export -f is_installed mark_installed log_install save_path is_apk_actually_installed install_apk install_pip install_npm parse_list

# ============================================================================
# FEATURE FLAG EXPANSION
# ============================================================================
if [ "$INSTALL_ALL" = "true" ] || [ "$INSTALL_ALL" = "1" ]; then
    export INSTALL_EDITORS="${INSTALL_EDITORS:-true}"
    export INSTALL_LANGUAGES="${INSTALL_LANGUAGES:-true}"
    export INSTALL_DATA="${INSTALL_DATA:-true}"
    export INSTALL_MEDIA="${INSTALL_MEDIA:-true}"
    export INSTALL_COMPRESSION="${INSTALL_COMPRESSION:-true}"
    export INSTALL_SCIENCE="${INSTALL_SCIENCE:-true}"
    export INSTALL_DB="${INSTALL_DB:-true}"
    export INSTALL_CLOUD="${INSTALL_CLOUD:-true}"
    export INSTALL_KUBERNETES="${INSTALL_KUBERNETES:-true}"
    export INSTALL_PYTHON="${INSTALL_PYTHON:-true}"
fi

# ============================================================================
# BACKGROUND INSTALLER FUNCTIONS (one per flag category)
# ============================================================================

install_editors() {
    if [ -n "$INSTALL_EDITORS" ] && [ "$INSTALL_EDITORS" != "false" ] && [ "$INSTALL_EDITORS" != "0" ]; then
        echo "=== [bg] Installing editors ===" >> "$INSTALL_LOG"
        for pkg in vim neovim nano; do
            install_apk "$pkg"
        done
        echo "=== [bg] Editors done ===" >> "$INSTALL_LOG"
    fi
}

install_languages() {
    LANG_DEFAULTS="python3 py3-pip ruby perl lua5.4 rust cargo go"
    LANG_LIST=$(parse_list "$INSTALL_LANGUAGES" "$LANG_DEFAULTS")
    if [ -n "$LANG_LIST" ]; then
        echo "=== [bg] Installing languages: $LANG_LIST ===" >> "$INSTALL_LOG"
        for pkg in $LANG_LIST; do
            install_apk "$pkg"
        done
        echo "=== [bg] Languages done ===" >> "$INSTALL_LOG"
    fi
}

install_data() {
    if [ -n "$INSTALL_DATA" ] && [ "$INSTALL_DATA" != "false" ] && [ "$INSTALL_DATA" != "0" ]; then
        echo "=== [bg] Installing data tools ===" >> "$INSTALL_LOG"
        for pkg in jq yq xmlstarlet sqlite; do
            install_apk "$pkg"
        done
        echo "=== [bg] Data tools done ===" >> "$INSTALL_LOG"
    fi
}

install_media() {
    if [ -n "$INSTALL_MEDIA" ] && [ "$INSTALL_MEDIA" != "false" ] && [ "$INSTALL_MEDIA" != "0" ]; then
        echo "=== [bg] Installing media tools ===" >> "$INSTALL_LOG"
        for pkg in imagemagick graphicsmagick pandoc poppler-utils ghostscript; do
            install_apk "$pkg"
        done
        echo "=== [bg] Media tools done ===" >> "$INSTALL_LOG"
    fi
}

install_compression() {
    if [ -n "$INSTALL_COMPRESSION" ] && [ "$INSTALL_COMPRESSION" != "false" ] && [ "$INSTALL_COMPRESSION" != "0" ]; then
        echo "=== [bg] Installing compression tools ===" >> "$INSTALL_LOG"
        for pkg in bzip2 xz zstd p7zip lz4; do
            install_apk "$pkg"
        done
        echo "=== [bg] Compression done ===" >> "$INSTALL_LOG"
    fi
}

install_science() {
    SCIENCE_DEFAULTS="numpy pandas scipy scikit-learn matplotlib seaborn plotly jupyter requests beautifulsoup4 pyyaml tqdm rich"
    SCIENCE_LIST=$(parse_list "$INSTALL_SCIENCE" "$SCIENCE_DEFAULTS")
    if [ -n "$SCIENCE_LIST" ]; then
        echo "=== [bg] Installing science packages: $SCIENCE_LIST ===" >> "$INSTALL_LOG"
        install_apk python3
        install_apk py3-pip
        
        # Map pip package names to Alpine APK equivalents (pre-compiled, much faster)
        # Packages not in this list fall back to pip install
        for pkg in $SCIENCE_LIST; do
            case "$pkg" in
                numpy)          install_apk py3-numpy ;;
                pandas)         install_apk py3-pandas ;;
                scipy)          install_apk py3-scipy ;;
                scikit-learn)   install_apk py3-scikit-learn ;;
                matplotlib)     install_apk py3-matplotlib ;;
                seaborn)        install_apk py3-seaborn ;;
                requests)       install_apk py3-requests ;;
                beautifulsoup4) install_apk py3-beautifulsoup4 ;;
                pyyaml)         install_apk py3-yaml ;;
                tqdm)           install_apk py3-tqdm ;;
                rich)           install_apk py3-rich ;;
                *)
                    # No APK equivalent, fall back to pip
                    install_pip "$pkg"
                    ;;
            esac
        done
        echo "=== [bg] Science packages done ===" >> "$INSTALL_LOG"
    fi
}

install_db() {
    if [ -n "$INSTALL_DB" ] && [ "$INSTALL_DB" != "false" ] && [ "$INSTALL_DB" != "0" ]; then
        echo "=== [bg] Installing database clients ===" >> "$INSTALL_LOG"
        for pkg in postgresql-client mysql-client redis; do
            install_apk "$pkg"
        done
        echo "=== [bg] Database clients done ===" >> "$INSTALL_LOG"
    fi
}

install_cloud() {
    if [ -n "$INSTALL_CLOUD" ] && [ "$INSTALL_CLOUD" != "false" ] && [ "$INSTALL_CLOUD" != "0" ]; then
        echo "=== [bg] Installing cloud CLI tools ===" >> "$INSTALL_LOG"
        install_apk python3
        install_apk py3-pip
        install_pip awscli
        if [ "$INSTALL_CLOUD" = "all" ] || [ "$INSTALL_CLOUD" = "azure" ]; then
            install_pip azure-cli
        fi
        echo "=== [bg] Cloud CLI done ===" >> "$INSTALL_LOG"
    fi
}

install_kubernetes() {
    if [ -n "$INSTALL_KUBERNETES" ] && [ "$INSTALL_KUBERNETES" != "false" ] && [ "$INSTALL_KUBERNETES" != "0" ]; then
        echo "=== [bg] Installing Kubernetes tools ===" >> "$INSTALL_LOG"
        
        # Helm requires openssl for checksum verification
        install_apk openssl
        
        if ! is_installed "bin:kubectl"; then
            log_install "kubectl"
            KUBECTL_VERSION=$(curl -fsSL --connect-timeout 10 --max-time 30 https://dl.k8s.io/release/stable.txt 2>/dev/null || echo "v1.29.0")
            ARCH=$(uname -m)
            case "$ARCH" in
                x86_64) ARCH="amd64" ;;
                aarch64) ARCH="arm64" ;;
            esac
            if curl -fsSL --connect-timeout 10 --max-time 120 "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl" -o "$TOOLS_DIR/bin/kubectl" && \
               chmod +x "$TOOLS_DIR/bin/kubectl"; then
                mark_installed "bin:kubectl"
            else
                echo "[warn] Failed to install kubectl" >> "$INSTALL_LOG"
                rm -f "$TOOLS_DIR/bin/kubectl"
            fi
        fi
        
        if ! is_installed "bin:helm"; then
            log_install "helm"
            if curl -fsSL --connect-timeout 10 --max-time 180 https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | HELM_INSTALL_DIR="$TOOLS_DIR/bin" USE_SUDO=false bash 2>&1 && \
               [ -x "$TOOLS_DIR/bin/helm" ]; then
                mark_installed "bin:helm"
            else
                echo "[warn] Failed to install helm" >> "$INSTALL_LOG"
            fi
        fi
        
        if ! is_installed "bin:k9s"; then
            log_install "k9s"
            ARCH=$(uname -m)
            case "$ARCH" in
                x86_64) K9S_ARCH="amd64" ;;
                aarch64) K9S_ARCH="arm64" ;;
                *) K9S_ARCH="" ;;
            esac
            if [ -n "$K9S_ARCH" ]; then
                K9S_VERSION=$(curl -fsSL --connect-timeout 10 --max-time 30 https://api.github.com/repos/derailed/k9s/releases/latest 2>/dev/null | grep '"tag_name"' | cut -d'"' -f4 || echo "v0.31.0")
                if curl -fsSL --connect-timeout 10 --max-time 120 "https://github.com/derailed/k9s/releases/download/${K9S_VERSION}/k9s_Linux_${K9S_ARCH}.tar.gz" | tar -xz -C "$TOOLS_DIR/bin" k9s && \
                   chmod +x "$TOOLS_DIR/bin/k9s"; then
                    mark_installed "bin:k9s"
                else
                    echo "[warn] Failed to install k9s" >> "$INSTALL_LOG"
                    rm -f "$TOOLS_DIR/bin/k9s"
                fi
            fi
        fi
        echo "=== [bg] Kubernetes tools done ===" >> "$INSTALL_LOG"
    fi
}

install_python() {
    PYTHON_DEFAULTS="requests httpx click python-dotenv watchdog python-dateutil loguru typer pydantic"
    PYTHON_LIST=$(parse_list "$INSTALL_PYTHON" "$PYTHON_DEFAULTS")
    if [ -n "$PYTHON_LIST" ]; then
        echo "=== [bg] Installing Python scripting packages: $PYTHON_LIST ===" >> "$INSTALL_LOG"
        install_apk python3
        install_apk py3-pip
        install_apk py3-certifi
        
        for pkg in $PYTHON_LIST; do
            case "$pkg" in
                requests)       install_apk py3-requests ;;
                python-dateutil) install_apk py3-dateutil ;;
                pyyaml)         install_apk py3-yaml ;;
                *)
                    install_pip "$pkg"
                    ;;
            esac
        done
        echo "=== [bg] Python scripting packages done ===" >> "$INSTALL_LOG"
    fi
}

install_custom() {
    if [ -n "$INSTALL_APK" ]; then
        echo "=== [bg] Installing custom apk packages ===" >> "$INSTALL_LOG"
        for pkg in $(echo "$INSTALL_APK" | tr ',' ' '); do
            install_apk "$pkg"
        done
    fi

    if [ -n "$INSTALL_PIP" ]; then
        echo "=== [bg] Installing custom pip packages ===" >> "$INSTALL_LOG"
        install_apk python3
        install_apk py3-pip
        for pkg in $(echo "$INSTALL_PIP" | tr ',' ' '); do
            install_pip "$pkg"
        done
    fi

    if [ -n "$INSTALL_NPM" ]; then
        echo "=== [bg] Installing custom npm packages ===" >> "$INSTALL_LOG"
        for pkg in $(echo "$INSTALL_NPM" | tr ',' ' '); do
            install_npm "$pkg"
        done
    fi
}

export -f install_editors install_languages install_data install_media install_compression
export -f install_science install_db install_cloud install_kubernetes install_python install_custom

# ============================================================================
# BASE PACKAGES (always installed, synchronously)
# ============================================================================
# SSL/TLS packages required for secure connections (curl, wget, Python requests, etc.)
echo "=== Installing base SSL packages ==="
sudo apk add --no-cache ca-certificates ca-certificates-bundle openssl >/dev/null 2>&1
sudo update-ca-certificates --fresh >/dev/null 2>&1

# ============================================================================
# LAUNCH BACKGROUND INSTALLERS (parallel per category)
# ============================================================================
PIDS=""

has_installs() {
    [ -n "$INSTALL_EDITORS" ] || [ -n "$INSTALL_LANGUAGES" ] || [ -n "$INSTALL_DATA" ] || \
    [ -n "$INSTALL_MEDIA" ] || [ -n "$INSTALL_COMPRESSION" ] || [ -n "$INSTALL_SCIENCE" ] || \
    [ -n "$INSTALL_DB" ] || [ -n "$INSTALL_CLOUD" ] || [ -n "$INSTALL_KUBERNETES" ] || \
    [ -n "$INSTALL_PYTHON" ] || [ -n "$INSTALL_APK" ] || [ -n "$INSTALL_PIP" ] || [ -n "$INSTALL_NPM" ]
}

if has_installs; then
    echo "=== Starting background package installation ==="
    echo "[$(date '+%H:%M:%S')] Installation started" > "$INSTALL_LOG"
    
    # Remove ready marker while installations are in progress
    rm -f "$READY_MARKER"
    
    # Launch each category in parallel
    # APK installs are serialized via flock, pip/npm can run in parallel
    
    bash -c 'install_editors' &
    PIDS="$PIDS $!"
    
    bash -c 'install_languages' &
    PIDS="$PIDS $!"
    
    bash -c 'install_data' &
    PIDS="$PIDS $!"
    
    bash -c 'install_media' &
    PIDS="$PIDS $!"
    
    bash -c 'install_compression' &
    PIDS="$PIDS $!"
    
    bash -c 'install_science' &
    PIDS="$PIDS $!"
    
    bash -c 'install_db' &
    PIDS="$PIDS $!"
    
    bash -c 'install_cloud' &
    PIDS="$PIDS $!"
    
    bash -c 'install_kubernetes' &
    PIDS="$PIDS $!"
    
    bash -c 'install_python' &
    PIDS="$PIDS $!"
    
    bash -c 'install_custom' &
    PIDS="$PIDS $!"
    
    echo "=== Background PIDs:$PIDS ==="
    echo "=== View progress: cat $INSTALL_LOG ==="
    
    # Background watcher that marks ready when all installers complete
    # Check /proc/$pid/stat to detect both exited and zombie processes
    # (kill -0 returns true for zombies, so we need to check process state)
    (
        echo "[$(date '+%H:%M:%S')] Watcher started, monitoring PIDs:$PIDS" >> "$INSTALL_LOG"
        
        is_process_running() {
            local pid=$1
            # Check if process exists and is not a zombie
            if [ -f "/proc/$pid/stat" ]; then
                # State is the 3rd field in /proc/pid/stat
                local state=$(cut -d' ' -f3 /proc/$pid/stat 2>/dev/null)
                # Z = zombie, X = dead - these mean process has finished
                [ "$state" != "Z" ] && [ "$state" != "X" ] && [ -n "$state" ]
            else
                return 1
            fi
        }
        
        iteration=0
        while true; do
            all_done=true
            running_pids=""
            for pid in $PIDS; do
                if is_process_running "$pid"; then
                    all_done=false
                    running_pids="$running_pids $pid"
                fi
            done
            if $all_done; then
                break
            fi
            # Log progress every 30 seconds (15 iterations * 2 sec sleep)
            iteration=$((iteration + 1))
            if [ $((iteration % 15)) -eq 0 ]; then
                echo "[$(date '+%H:%M:%S')] Still waiting for PIDs:$running_pids" >> "$INSTALL_LOG"
            fi
            sleep 2
        done
        echo "[$(date '+%H:%M:%S')] All installations complete" >> "$INSTALL_LOG"
        touch "$READY_MARKER"
        echo "=== Tools ready ==="
    ) &
    # Disown the watcher so it survives when exec replaces the shell
    disown
else
    # No installations requested, mark as ready immediately
    touch "$READY_MARKER"
fi

# ============================================================================
# START SERVER (foreground, becomes PID 1)
# ============================================================================
echo "=== Open Terminal Ready ==="
exec node /app/src/index.js "$@"
