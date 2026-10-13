"""agentbox-client: runs one agentbox-root verb through agentbox-rootd.

Hands the daemon this process's stdin, stdout and stderr, relays the pty an
interactive exec gets (raw mode here, window size changes forwarded), and
exits with the verb's status.

Usage: agentbox-client VERB [ARGS...]
"""

import fcntl
import json
import os
import select
import signal
import socket
import struct
import sys
import termios
import tty

SOCKET = "/run/agentbox/root.sock"
# After the exit status arrives, output still buffered in the pty is drained;
# this much silence means something left running inside holds the pty open.
DRAIN_IDLE_SECONDS = 0.2


def fail(message, code=255):
    print(f"agentbox: {message}", file=sys.stderr)
    sys.exit(code)


class Replies:
    def __init__(self, conn):
        self.conn = conn
        self.buf = b""
        self.fds = []

    def read(self):
        data, fds, _, _ = socket.recv_fds(self.conn, 4096, 1)
        self.fds.extend(fds)
        if not data:
            return None
        self.buf += data
        *lines, self.buf = self.buf.split(b"\n")
        return [json.loads(line) for line in lines if line]


def write_all(fd, data):
    view = memoryview(data)
    while view:
        view = view[os.write(fd, view):]


def pump(conn, replies, master, out):
    code = None
    pending = bytearray()
    readers = {0, master, conn.fileno()}
    os.set_blocking(master, False)
    while True:
        if code is not None and master not in readers:
            return code
        writers = [master] if pending and master in readers else []
        timeout = DRAIN_IDLE_SECONDS if code is not None else None
        ready, writable, _ = select.select(list(readers), writers, [], timeout)
        if not ready and not writable:
            return code
        if writable:
            try:
                del pending[: os.write(master, pending)]
            except BlockingIOError:
                pass
            except OSError:
                pending.clear()
        for fd in ready:
            if fd == 0:
                data = os.read(0, 1 << 16)
                if data:
                    pending += data
                else:
                    readers.discard(0)
            elif fd == master:
                try:
                    data = os.read(master, 1 << 16)
                except BlockingIOError:
                    continue
                except OSError:
                    data = b""
                if not data:
                    readers.discard(master)
                    continue
                try:
                    write_all(out, data)
                except OSError:
                    pass
            else:
                batch = replies.read()
                if batch is None:
                    fail("lost the connection to agentbox-rootd")
                for reply in batch:
                    if "exit" in reply:
                        code = reply["exit"]
                        readers.discard(conn.fileno())
                        readers.discard(0)


def relay(conn, replies, master):
    # The daemon only allocates a pty when stdin is a terminal.
    out = next((fd for fd in (1, 2) if os.isatty(fd)), 0)
    saved = termios.tcgetattr(0)

    def restore():
        termios.tcsetattr(0, termios.TCSADRAIN, saved)

    def resize(*_):
        try:
            fcntl.ioctl(master, termios.TIOCSWINSZ, fcntl.ioctl(0, termios.TIOCGWINSZ, bytes(8)))
        except OSError:
            pass

    def leave(sig, _frame):
        restore()
        signal.signal(sig, signal.SIG_DFL)
        os.kill(os.getpid(), sig)

    for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT, signal.SIGQUIT):
        signal.signal(sig, leave)
    signal.signal(signal.SIGWINCH, resize)
    tty.setraw(0)
    resize()
    try:
        return pump(conn, replies, master, out)
    finally:
        restore()


def main():
    # A closed standard descriptor cannot be passed; /dev/null stands in.
    for fd in (0, 1, 2):
        try:
            os.fstat(fd)
        except OSError:
            os.open(os.devnull, os.O_RDWR)
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, signal.SIG_DFL)

    request = json.dumps({"args": sys.argv[1:], "term": os.environ.get("TERM", "")}).encode()
    payload = struct.pack("!I", len(request)) + request
    conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        conn.connect(SOCKET)
    except OSError as error:
        fail(f"cannot reach agentbox-rootd at {SOCKET}: {error.strerror}")
    sent = socket.send_fds(conn, [payload], [0, 1, 2])
    conn.sendall(payload[sent:])

    replies = Replies(conn)
    while True:
        batch = replies.read()
        if batch is None:
            fail("lost the connection to agentbox-rootd")
        for reply in batch:
            if "error" in reply:
                print(f"agentbox: {reply['error']}", file=sys.stderr)
            if "exit" in reply:
                sys.exit(reply["exit"])
            if reply.get("pty") and replies.fds:
                sys.exit(relay(conn, replies, replies.fds.pop(0)))


if __name__ == "__main__":
    main()
