# Build stage - compile native modules
FROM node:22-alpine AS builder

RUN apk add --no-cache build-base cmake make python3

WORKDIR /app
COPY package.json yarn.lock* ./
RUN yarn install --production --frozen-lockfile 2>/dev/null || yarn install --production

# Runtime stage - minimal image
FROM node:22-alpine

# Runtime packages only (no build tools)
RUN apk add --no-cache \
    # Core utilities
    coreutils findutils grep sed gawk diffutils patch less file tree bash \
    # Networking
    curl wget net-tools iputils bind-tools netcat-openbsd socat openssh-client rsync \
    # Version control
    git \
    # System utilities
    procps htop lsof \
    # Terminal
    tmux screen sudo \
    # Certificates
    ca-certificates ca-certificates-bundle openssl \
    # Basic compression
    zip unzip tar gzip \
    && update-ca-certificates

# Add CA roots removed from Mozilla's bundle but still widely used.
# Comodo AAA Certificate Services — used by SSL.com/Cloudflare chains and many others.
# Fetched from crt.sh (ID 331986) and committed to the repo so the build has no
# outbound HTTPS dependency for a cert that cannot yet be trusted inside the image.
COPY certs/ /usr/local/share/ca-certificates/
RUN update-ca-certificates

WORKDIR /app

# Copy compiled node_modules from builder
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Copy source code
COPY src/ ./src/
COPY config.example.json ./
COPY entrypoint.sh ./

# Make entrypoint executable
RUN chmod +x /app/entrypoint.sh

# Create non-root user
RUN adduser -D -s /bin/bash sandbox \
    && echo 'sandbox ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers \
    && mkdir -p /opt/tools \
    && chown sandbox:sandbox /opt/tools

USER sandbox
WORKDIR /home/sandbox

VOLUME ["/opt/tools"]
EXPOSE 8000

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["run", "--host", "0.0.0.0"]
