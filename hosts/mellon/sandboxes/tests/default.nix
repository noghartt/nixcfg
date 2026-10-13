# VM test of the sandbox stack as Mellon runs it (../default.nix, unchanged):
# agentbox-rootd's authorization and descriptor passing, real sandboxes on a
# btrfs /agent, size classes, and net profiles against a `web` node that
# plays the internet: public-looking addresses (TEST-NET-2/3), and 1.1.1.1 as
# the upstream resolver, answering github.com (allowlisted for dev) and
# example.org (not).
#
#   nix build .#checks.x86_64-linux.agentbox
#   nix run .#checks.x86_64-linux.agentbox.driverInteractive   # to poke at it
{ pkgs, flake }:
let
  allowed = "203.0.113.10";
  other = "198.51.100.10";

  # Builds one DNS query for github.com, so the test can ask a resolver the
  # sandbox was not given without needing dig in the image.
  dnsQuery = pkgs.writeText "dns-query.py" ''
    import socket, sys
    q = b"\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x06github\x03com\x00\x00\x01\x00\x01"
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(5)
    s.sendto(q, (sys.argv[1], 53))
    print(len(s.recv(512)))
  '';

  # Drives `agentbox shell` through a terminal the way a person would.
  terminal = pkgs.writeText "terminal.py" ''
    import fcntl, os, pty, select, struct, sys, termios, time

    def winsize(fd, rows, cols):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    pid, fd = pty.fork()
    if pid == 0:
        winsize(0, 30, 100)
        os.execvp("agentbox", ["agentbox", "shell", sys.argv[1]])

    seen = b""

    def expect(pattern, timeout=60):
        global seen
        end = time.monotonic() + timeout
        while pattern not in seen:
            left = end - time.monotonic()
            if left <= 0 or not select.select([fd], [], [], left)[0]:
                sys.exit(f"timed out waiting for {pattern!r}; got {seen[-800:]!r}")
            seen += os.read(fd, 4096)
        found = seen
        seen = seen[seen.index(pattern) + len(pattern):]
        return found

    def send(text):
        os.write(fd, text.encode())

    # Input typed before the shell's first prompt can be discarded. Typed lines
    # are echoed back, so what is typed never spells what is awaited.
    expect(b"$ ")
    send("PS1='\\122EADY> '\n")
    expect(b"READY> ")
    send("stty size\n")
    expect(b"30 100")
    winsize(fd, 50, 140)
    send("stty size\n")
    expect(b"50 140")
    send("sleep 300 &\n")
    expect(b"READY> ")
    send("jobs -l; kill %1\n")
    expect(b"sleep 300")
    send("sh -c 'trap \"echo got-int; exit 3\" INT; echo arm\\ed; while :; do sleep 0.1; done'\n")
    expect(b"armed")
    send("\x03")
    expect(b"got-int")
    send("echo status-$?\n")
    expect(b"status-3")
    send("exit 5\n")
    _, status = os.waitpid(pid, 0)
    if b"no job control" in seen:
        sys.exit("the shell got no controlling terminal")
    print(os.waitstatus_to_exitcode(status))
  '';
in
pkgs.testers.runNixOSTest {
  name = "agentbox";
  node.specialArgs = { inherit flake; };

  nodes.web = {
    virtualisation.vlans = [ 1 ];
    networking.firewall.enable = false;
    networking.interfaces.eth1.ipv4.addresses = [
      {
        address = allowed;
        prefixLength = 24;
      }
      {
        address = other;
        prefixLength = 24;
      }
      {
        address = "1.1.1.1";
        prefixLength = 32;
      }
    ];
    services.dnsmasq = {
      enable = true;
      resolveLocalQueries = false;
      settings = {
        interface = "eth1";
        no-resolv = true;
        no-hosts = true;
        address = [
          "/github.com/${allowed}"
          "/example.org/${other}"
        ];
      };
    };
    systemd.services.web = {
      wantedBy = [ "multi-user.target" ];
      serviceConfig.ExecStart = "${pkgs.python3}/bin/python3 -m http.server 80 --directory ${pkgs.writeTextDir "index.html" "hello from web"}";
    };
  };

  nodes.machine = {
    imports = [ ../. ];
    virtualisation = {
      vlans = [ 1 ];
      cores = 8;
      memorySize = 4096;
      diskSize = 4096;
      emptyDiskImages = [ 8192 ];
    };
    # As on Mellon, where NetworkManager owns the uplink: no dhcpcd grabbing
    # the sandboxes' veths.
    networking.useDHCP = false;
    networking.interfaces.eth1.ipv4 = {
      addresses = [
        {
          address = "203.0.113.1";
          prefixLength = 24;
        }
        {
          address = "198.51.100.1";
          prefixLength = 24;
        }
      ];
      routes = [
        {
          address = "1.1.1.1";
          prefixLength = 32;
          via = allowed;
        }
      ];
    };
    environment.systemPackages = [
      pkgs.btrfs-progs
      pkgs.conntrack-tools
      pkgs.git
    ];
    users.users.alice = {
      isNormalUser = true;
      extraGroups = [ "agentbox" ];
    };
    users.users.bob.isNormalUser = true;
  };

  testScript = ''
    import shlex

    def alice(command):
        return f"su - alice -c {shlex.quote(command)}"

    def run(box, command):
        return machine.succeed(alice(f"agentbox exec {box} -- {command}")).strip()

    def row(box):
        rows = [r.split("\t") for r in machine.succeed(alice("agentbox ls")).strip().splitlines()]
        return next(r for r in rows if r[0] == box)

    def memory_max(box):
        return machine.succeed(f"systemctl show -p MemoryMax --value agentbox-{box}.slice").strip()

    # A freshly booted sandbox needs a moment for its DHCP lease.
    def wait_online(box):
        machine.wait_until_succeeds(alice(f"agentbox exec {box} -- sh -c 'ip -4 -o addr show host0 | grep -q inet'"), timeout=60)

    def reaches(box, url):
        status, _ = machine.execute(alice(f"agentbox exec {box} -- curl -sf --max-time 5 {url}"))
        return status == 0

    start_all()
    web.wait_for_unit("web.service")
    web.wait_for_unit("dnsmasq.service")
    machine.wait_for_unit("multi-user.target")
    machine.wait_for_unit("agentbox-root.socket")
    machine.succeed("mkfs.btrfs -q /dev/vdb", "mount /dev/vdb /agent", "systemctl restart agentbox-base")

    with subtest("authorization comes from the group database, not the process"):
        status, out = machine.execute("su - bob -c 'agentbox ls' 2>&1")
        assert status == 1 and "not in the agentbox group" in out, out
        gid = machine.succeed("getent group agentbox | cut -d: -f3").strip()
        groups = machine.succeed("setpriv --reuid=alice --regid=users --clear-groups id -G").split()
        assert gid not in groups, groups
        machine.succeed("setpriv --reuid=alice --regid=users --clear-groups agentbox ls")
        machine.fail("grep -r agentbox-root /etc/sudoers")

    with subtest("exit status and stderr come back without a sandbox"):
        status, out = machine.execute(alice("agentbox start nosuch 2>&1 >/dev/null"))
        assert status == 1 and "no sandbox named nosuch" in out, (status, out)
        status, out = machine.execute(alice("agentbox exec 'Bad!' -- true 2>&1"))
        assert status == 1 and "invalid sandbox name" in out, (status, out)
        assert machine.succeed(alice("agentbox net nosuch 2>&1 || true")).strip() == "agentbox: no sandbox named nosuch"

    with subtest("ensure creates with a size class and the default profile"):
        out = machine.succeed(alice("agentbox ensure t1 --size small")).strip().splitlines()
        assert out[-1] == "/home/agent", out
        wait_online("t1")
        assert row("t1")[-2:] == ["dev", "small"], row("t1")
        assert run("t1", "nproc") == "4"
        assert memory_max("t1") == str(8 << 30)

    with subtest("exec passes descriptors and exit codes"):
        status, _ = machine.execute(alice("agentbox exec t1 -- sh -c 'exit 7'"))
        assert status == 7, status
        assert machine.succeed(alice("echo hello | agentbox exec t1 -- cat")).strip() == "hello"
        assert machine.succeed(alice("agentbox exec t1 -- sh -c 'echo out; echo err >&2' 2>/dev/null")).strip() == "out"
        out = machine.succeed(alice("script -qec 'stty cols 123 rows 45; agentbox exec t1 -- sh -c \"test -t 0 && test -t 1 && stty size\"' /dev/null"))
        assert "45 123" in out, out
        status, _ = machine.execute(alice("agentbox exec t1 -- test -t 0 </dev/null"))
        assert status == 1, "a non-terminal stdin must stay one"

    with subtest("an interactive shell has job control, signals and window size"):
        out = machine.succeed(alice("${pkgs.python3.interpreter} ${terminal} t1"))
        assert out.strip().splitlines()[-1] == "5", out

    with subtest("concurrent calls keep their own status"):
        out = machine.succeed(alice(
            "for i in $(seq 40); do (agentbox exec t1 -- sh -c \"exit $((i % 4))\"; echo \"$i $?\") & done; wait"
        ))
        results = dict(line.split() for line in out.strip().splitlines())
        assert len(results) == 40, out
        for i, code in results.items():
            assert int(code) == int(i) % 4, (i, code)

    with subtest("no caller environment reaches the root side"):
        machine.succeed(alice("LEAKME=1 agentbox exec t1 -- sleep 4242 >/dev/null 2>&1 &"))
        machine.wait_until_succeeds("pgrep -x sleep")
        machine.succeed("pid=$(pgrep -x nsenter | head -n1); test -n \"$pid\"; ! grep -qa LEAKME /proc/$pid/environ")

    with subtest("a killed client takes its command with it"):
        machine.succeed("pkill -KILL -x agentbox-client")
        machine.wait_until_fails("pgrep -x sleep", timeout=30)

    with subtest("size changes apply to a running sandbox"):
        assert machine.succeed(alice("agentbox size t1 medium")).strip() == "medium"
        assert run("t1", "nproc") == "8"
        assert memory_max("t1") == str(16 << 30)
        machine.succeed(alice("agentbox size t1 large"))
        assert run("t1", "nproc") == "8"
        assert memory_max("t1") == str(32 << 30)
        machine.fail(alice("agentbox size t1 huge"))

    def network_state(box):
        for command in [
            alice(f"agentbox exec {box} -- sh -c 'cat /etc/resolv.conf; ip -4 addr; ip route; getent ahostsv4 github.com'"),
            "ipset list; iptables -t mangle -L -v -n; iptables -t nat -L agentbox-dns -v -n",
            "journalctl -u agentbox-dns --no-pager | tail -20",
        ]:
            print(machine.execute(command)[1])

    with subtest("dev reaches only allowlisted names"):
        try:
            machine.wait_until_succeeds(alice("agentbox exec t1 -- curl -sf --max-time 5 http://github.com/"), timeout=60)
        except Exception:
            network_state("t1")
            raise
        assert run("t1", "curl -sf --max-time 5 http://github.com/") == "hello from web"
        assert not reaches("t1", "http://example.org/")
        assert not reaches("t1", "http://${other}/")
        assert not reaches("t1", "http://203.0.113.1/"), "the host itself"
        # DNS sent elsewhere lands on the sandbox resolver (9.9.9.9 is not routed here).
        run("t1", "python3 -c \"$(cat ${dnsQuery})\" 9.9.9.9")

    with subtest("open reaches any public address, and narrowing drops tracked connections"):
        assert machine.succeed(alice("agentbox net t1 open")).strip() == "open"
        assert reaches("t1", "http://${other}/")
        assert reaches("t1", "http://example.org/")
        index = int(machine.succeed("cat /agent/net/t1"))
        subnet = f"10.231.{index * 16 // 256}.{index * 16 % 256}"
        tracked = f"conntrack -L -f ipv4 -s {subnet} --mask-src 255.255.255.240 2>/dev/null | grep -c ${other} || true"
        assert int(machine.succeed(tracked)) > 0
        machine.succeed(alice("agentbox net t1 dev"))
        assert int(machine.succeed(tracked)) == 0
        assert not reaches("t1", "http://${other}/")

    with subtest("none reaches nothing, not even DNS"):
        machine.succeed(alice("agentbox net t1 none"))
        assert not reaches("t1", "http://${allowed}/")
        machine.fail(alice("agentbox exec t1 -- python3 -c \"$(cat ${dnsQuery})\" 10.231.0.17"))
        machine.fail(alice("agentbox net t1 bogus"))

    with subtest("a sandbox without a recorded profile counts as open"):
        # After the switch, agentbox-net (net-sync) files such sandboxes under open.
        machine.succeed("rm /agent/meta/t1.net", "systemctl restart agentbox-net")
        assert machine.succeed(alice("agentbox net t1")).strip() == "open"
        assert row("t1")[-2] == "open"
        assert reaches("t1", "http://${other}/")

    with subtest("ensure updates an existing sandbox and seeds a new one"):
        out = machine.succeed(alice("agentbox ensure t1 --net dev --size small")).strip().splitlines()
        assert out[-1] == "/home/agent" and row("t1")[-2:] == ["dev", "small"], (out, row("t1"))
        assert run("t1", "nproc") == "4"
        machine.succeed(alice("git init -q ~/repo && git -C ~/repo -c user.name=a -c user.email=a@b commit -q --allow-empty -m first"))
        out = machine.succeed(alice("agentbox ensure t2 --seed ~/repo --net none")).strip().splitlines()
        assert out[-1] == "/home/agent/repo", out
        wait_online("t2")
        assert run("t2", "git -C /home/agent/repo log --format=%s") == "first"
        assert row("t2")[-2:] == ["none", "medium"], row("t2")
        assert not reaches("t2", "http://${allowed}/")

    with subtest("recreate keeps net and size"):
        machine.succeed(alice("agentbox net t1 open"), alice("agentbox size t1 small"))
        machine.succeed(alice("agentbox recreate t1 --yes"))
        wait_online("t1")
        assert row("t1")[-2:] == ["open", "small"], row("t1")
        assert run("t1", "nproc") == "4"
        assert reaches("t1", "http://${other}/")

    with subtest("rm releases the sandbox's subnet"):
        index = int(machine.succeed("cat /agent/net/t2"))
        machine.succeed(alice("agentbox rm t2 --yes"))
        machine.fail(f"ipset list agentbox-src-none | grep -q '10.231.{index * 16 // 256}.{index * 16 % 256}/28'")
  '';
}
