#!/bin/bash
set -e

IMAGE_NAME="open-terminal-lite"
CONTAINER_NAME="open-terminal-lite-dev"
PORT="${PORT:-8000}"

usage() {
    echo "Usage: $0 <command>"
    echo ""
    echo "Commands:"
    echo "  build       Build the Docker image"
    echo "  reset       Deletes the container and image and rebuilds (removes all data)"
    echo "  run         Run the container (builds first if needed)"
    echo "  stop        Stop the running container"
    echo "  logs        Show container logs"
    echo "  shell       Open a shell in the running container"
    echo "  clean       Remove container and image"
    echo "  test        Run a quick API test"
    echo ""
    echo "Environment variables:"
    echo "  PORT        Port to expose (default: 8000)"
    echo "  API_KEY     API key to use (default: auto-generated)"
    echo "  INSTALL_*   Package installation flags (auto-forwarded to container)"
    echo "              Examples: INSTALL_ALL, INSTALL_EDITORS, INSTALL_LANGUAGES,"
    echo "                        INSTALL_SCIENCE, INSTALL_DATA, INSTALL_MEDIA,"
    echo "                        INSTALL_DB, INSTALL_CLOUD, INSTALL_KUBERNETES"
    exit 1
}

build() {
    echo "Building Docker image..."
    docker build -t "$IMAGE_NAME" .
    echo "Done! Image: $IMAGE_NAME"
}

run() {
    # Build if image doesn't exist
    if ! docker image inspect "$IMAGE_NAME" &>/dev/null; then
        build
    fi

    # Stop existing container if running
    if docker ps -q -f name="$CONTAINER_NAME" | grep -q .; then
        echo "Stopping existing container..."
        docker stop "$CONTAINER_NAME" >/dev/null
    fi

    # Remove existing container
    docker rm "$CONTAINER_NAME" 2>/dev/null || true

    echo "Starting container on port $PORT..."
    
    # Build docker run command
    DOCKER_ARGS=(
        -d
        --rm
        --name "$CONTAINER_NAME"
        -p "$PORT:8000"
        -v "test-sandbox:/home/sandbox/usrfs"
        -v "test-tools:/opt/tools"
        -e "SHOW_DOCS=true"
    )

    if [ -n "$API_KEY" ]; then
        DOCKER_ARGS+=(-e "OPEN_TERMINAL_API_KEY=$API_KEY")
    fi

    # Pass through all INSTALL_* environment variables
    while IFS='=' read -r name value; do
        DOCKER_ARGS+=(-e "$name=$value")
    done < <(env | grep '^INSTALL_')

    docker run "${DOCKER_ARGS[@]}" "$IMAGE_NAME"

    echo ""
    echo "Container started!"
    echo "  URL: http://localhost:$PORT"
    echo "  Health: http://localhost:$PORT/health"
    echo ""
    
    # Show logs to capture the API key
    sleep 2
    docker logs "$CONTAINER_NAME" 2>&1 | head -20
}

reset() {
    echo "Resetting container..."
    stop
    clean
    build
    run
}

stop() {
    echo "Stopping container..."
    docker stop "$CONTAINER_NAME" 2>/dev/null || echo "Container not running"
    docker rm "$CONTAINER_NAME" 2>/dev/null || true
}

logs() {
    docker logs -f "$CONTAINER_NAME"
}

shell() {
    docker exec -it "$CONTAINER_NAME" /bin/bash
}

clean() {
    echo "Cleaning up..."
    docker stop "$CONTAINER_NAME" 2>/dev/null || true
    docker rm "$CONTAINER_NAME" 2>/dev/null || true
    docker rmi "$IMAGE_NAME" 2>/dev/null || true
    echo "Done!"
}

test_api() {
    echo "Testing API..."
    echo ""
    
    echo "1. Health check:"
    curl -s "http://localhost:$PORT/health" | jq .
    echo ""
    
    echo "2. List files (requires API key):"
    if [ -n "$API_KEY" ]; then
        curl -s -H "Authorization: Bearer $API_KEY" "http://localhost:$PORT/files/list?directory=/home/sandbox" | jq .
    else
        echo "   Skipped - set API_KEY env var to test authenticated endpoints"
    fi
}

case "${1:-}" in
    build) build ;;
    reset) reset ;;
    run) run ;;
    stop) stop ;;
    logs) logs ;;
    shell) shell ;;
    clean) clean ;;
    test) test_api ;;
    *) usage ;;
esac
