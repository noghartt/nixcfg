"""agentbox-rootd: serves one connection to /run/agentbox/root.sock.

systemd accepts each connection (Accept=yes) and starts one of these as root
with it on stdin. The peer is identified by its kernel credentials and let in
when the group database lists its user in the agentbox group, so a process
started before its user joined the group (a long-lived Herdr server) still
gets in. The request is one agentbox-root verb plus the caller's stdin,
stdout and stderr as descriptors; the verb runs on those, except that an exec
whose stdin is a terminal gets a fresh pty as its controlling terminal (the
client relays it), so job control, terminal signals and window size work
inside the sandbox. The verb's exit status goes back to the client. A client
that disconnects first takes the verb with it.

Usage: agentbox-rootd AGENTBOX_ROOT
"""

import fcntl
import grp
import json
import os
import pwd
import re
import select
import signal
import socket
import struct
import subprocess
import sys
import termios

GROUP = "agentbox"
MAX_REQUEST = 8 << 20
TERM = re.compile(r"[A-Za-z0-9._+-]{1,64}")
SIGTERM_GRACE_SECONDS = 10


def log(message):
    # "<4>" is journald's warning priority; the unit drops anything below
    # notice, including systemd's own start/stop lines for each connection.
    print(f"<4>agentbox-rootd: {message}", file=sys.stderr, flush=True)


def send(conn, message, fds=()):
    data = json.dumps(message).encode() + b"\n"
    try:
        if fds:
            sent = socket.send_fds(conn, [data], list(fds))
            conn.sendall(data[sent:])
        else:
            conn.sendall(data)
    except OSError:
        pass


def authorized(uid):
    if uid == 0:
        return True
    try:
        user = pwd.getpwuid(uid)
        gid = grp.getgrnam(GROUP).gr_gid
    except KeyError:
        return False
    return gid in os.getgrouplist(user.pw_name, user.pw_gid)


def recv_exact(conn, buf, size):
    while len(buf) < size:
        more = conn.recv(min(size - len(buf), 1 << 16))
        if not more:
            raise ValueError("request cut short")
        buf += more
    return buf


def read_request(conn):
    data, fds, flags, _ = socket.recv_fds(conn, 1 << 16, 3)
    if flags & socket.MSG_CTRUNC or len(fds) != 3:
        for fd in fds:
            os.close(fd)
        raise ValueError("expected exactly stdin, stdout and stderr")
    try:
        buf = recv_exact(conn, data, 4)
        (size,) = struct.unpack("!I", buf[:4])
        if size > MAX_REQUEST:
            raise ValueError("request too large")
        buf = recv_exact(conn, buf, 4 + size)
        if len(buf) != 4 + size:
            raise ValueError("trailing data after the request")
        request = json.loads(buf[4:])
        args = request["args"]
        strings = isinstance(args, list) and all(isinstance(a, str) and "\0" not in a for a in args)
        if not strings or not args:
            raise ValueError("args must be a non-empty list of strings")
        term = request.get("term")
        if not isinstance(term, str) or not TERM.fullmatch(term):
            term = "dumb"
    except (ValueError, KeyError, TypeError, OSError) as error:
        for fd in fds:
            os.close(fd)
        raise ValueError(f"bad request: {error}") from error
    return args, term, fds


def scope(pid):
    """The cgroup of an exec's scope (enter() in agentbox-root), if pid is in one."""
    try:
        with open(f"/proc/{pid}/cgroup") as f:
            for line in f:
                if line.startswith("0::"):
                    path = line[3:].strip()
                    if path.startswith("/agentbox.slice/") and path.endswith(".scope"):
                        return path
    except OSError:
        pass
    return None


def kill_scope(pid):
    path = scope(pid)
    if path:
        try:
            with open(f"/sys/fs/cgroup{path}/cgroup.kill", "w") as f:
                f.write("1")
        except OSError:
            pass


def killpg(pid, sig):
    try:
        os.killpg(pid, sig)
    except ProcessLookupError:
        pass


def terminate(proc, pidfd):
    # An exec's command (and whatever it started) lives in its own scope in
    # the sandbox's slice, outside this unit, so stopping this unit would not
    # reach it: kill the scope. Other verbs get SIGTERM first, as Ctrl+C
    # would have done under sudo.
    kill_scope(proc.pid)
    killpg(proc.pid, signal.SIGTERM)
    if not select.select([pidfd], [], [], SIGTERM_GRACE_SECONDS)[0]:
        kill_scope(proc.pid)
        killpg(proc.pid, signal.SIGKILL)
    proc.wait()


def controlling_tty():
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)


def status(code):
    return 128 - code if code < 0 else code


def main():
    root = sys.argv[1]
    conn = socket.socket(fileno=os.dup(0))
    null = os.open(os.devnull, os.O_RDWR)
    os.dup2(null, 0)
    os.close(null)

    pid, uid, _ = struct.unpack(
        "3i", conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    )
    if not authorized(uid):
        log(f"refused uid {uid} (pid {pid}): not in the {GROUP} group")
        send(conn, {"error": f"uid {uid} is not in the {GROUP} group (add it to the user's extraGroups and rebuild)", "exit": 1})
        return

    conn.settimeout(30)
    try:
        args, term, fds = read_request(conn)
    except (ValueError, OSError) as error:
        log(f"uid {uid} (pid {pid}): {error}")
        send(conn, {"error": str(error), "exit": 1})
        return
    conn.settimeout(None)

    master = None
    std = list(fds)
    if args[0] == "exec" and os.isatty(fds[0]):
        master, slave = os.openpty()
        try:
            termios.tcsetattr(slave, termios.TCSANOW, termios.tcgetattr(fds[0]))
            size = fcntl.ioctl(fds[0], termios.TIOCGWINSZ, bytes(8))
            fcntl.ioctl(slave, termios.TIOCSWINSZ, size)
        except (OSError, termios.error):
            pass
        std = [slave if os.isatty(fd) else fd for fd in fds]

    # Nothing from the caller's environment: only a validated TERM.
    env = {
        "PATH": os.environ.get("PATH", "/run/current-system/sw/bin"),
        "LANG": "C.UTF-8",
        "TERM": term,
    }
    try:
        proc = subprocess.Popen(
            [root, *args],
            stdin=std[0],
            stdout=std[1],
            stderr=std[2],
            env=env,
            cwd="/",
            start_new_session=True,
            preexec_fn=controlling_tty if master is not None else None,
        )
    finally:
        for fd in set(std) | set(fds):
            os.close(fd)
    if master is not None:
        send(conn, {"pty": True}, [master])
        os.close(master)

    pidfd = os.pidfd_open(proc.pid)
    poller = select.poll()
    poller.register(pidfd, select.POLLIN)
    poller.register(conn, select.POLLIN | select.POLLRDHUP)
    while True:
        for fd, _ in poller.poll():
            if fd == pidfd:
                send(conn, {"exit": status(proc.wait())})
                return
            # The client sends nothing after its request: readable means gone.
            try:
                gone = not conn.recv(4096, socket.MSG_DONTWAIT)
            except BlockingIOError:
                gone = False
            except OSError:
                gone = True
            if gone:
                terminate(proc, pidfd)
                return


if __name__ == "__main__":
    main()
