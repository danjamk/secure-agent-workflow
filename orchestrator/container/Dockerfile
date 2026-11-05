# The run's container image (#79). For now it runs only probe.sh, a fixed script
# that tests the outbound policy. #9 adds the agent CLI.
#
# The base is pinned by digest. Debian's packages aren't pinned, so a rebuild can
# pick up newer security updates.
FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl git jq \
    && rm -rf /var/lib/apt/lists/*

COPY probe.sh /probe/probe.sh
RUN chmod 0555 /probe/probe.sh

# The orchestrator starts the probe with exec. This keeps the container up until then.
CMD ["sleep", "infinity"]
