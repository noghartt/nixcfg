# VM test for the agent-forum unit: it boots under its hardening, serves
# loopback, picks up a late tailscale0 address, and stays off other interfaces.
# Not a flake check (needs KVM and a VM boot); run it by hand:
#   nix build -L --impure --expr \
#     '(builtins.getFlake (toString ./.)).inputs.nixpkgs.legacyPackages.x86_64-linux.callPackage ./hosts/mellon/agent-forum/vm-test.nix { }'
{ testers }:
testers.runNixOSTest {
  name = "agent-forum";
  nodes.machine = {
    imports = [ ./default.nix ];
    systemd.services.agent-forum.environment.AGENT_FORUM_RESCAN_SECONDS = "1";
  };
  testScript = ''
    import json

    author = "-H 'x-forum-author: mellon/omo/vm-test' -H 'content-type: application/json'"

    machine.wait_for_unit("agent-forum.service")
    machine.wait_until_succeeds("curl -sf http://127.0.0.1:7410/api/health")

    created = json.loads(machine.succeed(
        f"curl -sf {author} -d '{{\"title\":\"VM smoke\",\"kind\":\"request\",\"tags\":[\"vm\"]}}' http://127.0.0.1:7410/api/threads"
    ))
    thread = created["thread"]["id"]
    machine.succeed(
        f"curl -sf -H 'x-forum-author: mellon/pi/other' -H 'content-type: application/json' -d '{{\"body\":\"hi\"}}' http://127.0.0.1:7410/api/threads/{thread}/replies"
    )
    waited = json.loads(machine.succeed(f"curl -sf {author} 'http://127.0.0.1:7410/api/wait?thread={thread}&since=0&timeout=5'"))
    assert waited["events"][0]["reply"]["body"] == "hi", waited
    machine.succeed("curl -sf http://127.0.0.1:7410/ | grep -q 'VM smoke'")
    machine.succeed("test -f /var/lib/agent-forum/forum.sqlite-wal || test -f /var/lib/private/agent-forum/forum.sqlite-wal")

    machine.fail("curl -sf --max-time 3 http://100.100.7.7:7410/api/health")
    machine.succeed("ip link add tailscale0 type dummy && ip addr add 100.100.7.7/32 dev tailscale0 && ip link set tailscale0 up")
    machine.wait_until_succeeds("curl -sf http://100.100.7.7:7410/api/health")

    eth1 = machine.succeed("ip -4 -o addr show eth1 | awk '{print $4}' | cut -d/ -f1").strip()
    machine.fail(f"curl -sf --max-time 3 http://{eth1}:7410/api/health")

    machine.succeed("systemctl restart agent-forum.service")
    machine.wait_until_succeeds("curl -sf http://127.0.0.1:7410/api/health")
    machine.succeed(f"curl -sf http://127.0.0.1:7410/api/threads/{thread} | grep -q 'VM smoke'")
  '';
}
