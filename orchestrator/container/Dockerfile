# The run's container image. It holds both runners: the agent (run-agent.sh, with
# Claude Code) and the outbound probe (probe.sh). The Worker picks one per run.
#
# The base is pinned by digest, and Claude Code by version, both past the two-week
# rule. Debian's packages aren't pinned, so a rebuild picks up security updates.
FROM node:24-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl git jq make \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global --no-audit --no-fund @anthropic-ai/claude-code@2.1.309 \
    && npm cache clean --force

# Claude Code won't skip its permission prompts as root. A separate user doesn't
# limit what the agent can do in the container, which the security docs say plainly:
# the container is the boundary.
RUN useradd --create-home --uid 1001 --shell /bin/bash agent \
    && mkdir -p /workspace/task \
    && chown -R agent:agent /workspace

COPY probe.sh run-agent.sh agent-gh /agent/
RUN chmod 0555 /agent/probe.sh /agent/run-agent.sh /agent/agent-gh \
    && ln -s /agent/agent-gh /usr/local/bin/agent-gh

# The orchestrator starts the runner with exec. This keeps the container up until then.
CMD ["sleep", "infinity"]
