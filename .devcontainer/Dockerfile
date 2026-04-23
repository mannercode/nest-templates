FROM node:24-slim
ENV LANG=C.UTF-8

ARG REQUIRED="git curl jq ca-certificates"
ARG DEV_TOOLS="tree tmux iproute2"
ARG PLANTUML="openjdk-17-jre-headless graphviz fonts-noto-cjk"
ARG SHELL_FORMATTER="shfmt"
RUN set -Eeu; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
    $REQUIRED \
    $DEV_TOOLS \
    $PLANTUML \
    $SHELL_FORMATTER; \
    rm -rf /var/lib/apt/lists/*; \
    curl -fsSL "https://github.com/plantuml/plantuml/releases/latest/download/plantuml.jar" -o /opt/plantuml.jar; \
    npm i -g npm-check-updates husky @commitlint/cli @anthropic-ai/claude-code; \
    npm cache clean --force
