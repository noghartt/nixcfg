FROM docker/sandbox-templates:shell

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends tmux ripgrep fd-find jq \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf "$(command -v fdfind)" /usr/local/bin/fd

COPY omo /usr/local/bin/omo
COPY swarm /opt/swarm/swarm
RUN chmod 0755 /usr/local/bin/omo \
    && mkdir -p /home/agent/swarm /home/agent/.swarm/agents /home/agent/.swarm-skills \
    && chown -R agent:agent /home/agent/swarm /home/agent/.swarm /home/agent/.swarm-skills

USER agent
ENV PI_OFFLINE=1
# swarmd starts members as tmux sessions through `sbx exec`; the workload itself only
# keeps the sandbox alive.
ENTRYPOINT ["sleep", "infinity"]
