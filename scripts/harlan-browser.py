#!/usr/bin/env python3
"""Launch and connect to Clients and Agent Chrome with isolated data directories."""

import json
import os
import re
from pathlib import Path
import shutil
import socket
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import build_opener, ProxyHandler

PORTS = {"clients": 9223, "agent": 9224}


def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)


def port(identity):
    value = os.environ.get(f"HARLAN_BROWSER_{identity.upper()}_PORT", str(PORTS[identity]))
    if not value.isdigit() or not 1024 <= int(value) <= 65535:
        fail("Use a debugging port between 1024 and 65535.")
    return int(value)


def data_root():
    return Path(os.environ.get("HARLAN_BROWSER_ROOT", str(Path.home() / ".local/share/harlan-agent-kit/chrome"))).resolve()


def flag_matches(command_line, flag):
    return re.search(r"(?:^|[\x00\s])" + re.escape(flag) + r"(?=\x00|\s+--|$)", command_line) is not None


def owner(identity, root):
    expected = f"--user-data-dir={root / identity}"
    command = shutil.which("google-chrome")
    if not command:
        return None
    launcher = Path(command).resolve()
    executables = {launcher, launcher.parent / "chrome"}
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        try:
            command_line = (proc / "cmdline").read_bytes().decode(errors="replace").rstrip("\0")
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            # Processes can disappear during enumeration; unrelated processes may deny access.
            continue
        # Chrome can rewrite argv as one process-title string on Linux.
        if flag_matches(command_line, expected) and not re.search(r"(?:^|[\x00\s])--type=", command_line):
            try:
                if proc.stat().st_uid != os.getuid() or (proc / "exe").resolve(strict=True) not in executables:
                    continue
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                # The candidate browser may exit during inspection.
                continue
            return {"pid": int(proc.name), "debugging": flag_matches(command_line, f"--remote-debugging-port={port(identity)}"),
                    "headless": flag_matches(command_line, "--headless")}
    return None


def owns_listener(pid, expected_port):
    proc = Path("/proc") / str(pid)
    try:
        sockets = set()
        for line in (proc / "net/tcp").read_text().splitlines()[1:]:
            fields = line.split()
            address, local_port = fields[1].split(":")
            if address == "0100007F" and int(local_port, 16) == expected_port and fields[3] == "0A":
                sockets.add(f"socket:[{fields[9]}]")
        for fd in (proc / "fd").iterdir():
            try:
                if os.readlink(fd) in sockets:
                    return True
            except FileNotFoundError:
                # A socket can close while Chrome is running.
                continue
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        # An exited or unreadable process cannot establish endpoint ownership.
        return False
    return False


def status(identity, root):
    endpoint = f"http://127.0.0.1:{port(identity)}"
    process = owner(identity, root)
    result = {"identity": identity, "endpoint": endpoint, "dataDirectory": str(root / identity), "ready": False}
    if not process:
        return {**result, "reason": "Open the dedicated browser."}
    if not process["debugging"]:
        return {**result, "reason": "Close this dedicated browser and reopen its launcher."}
    if not owns_listener(process["pid"], port(identity)):
        return {**result, "reason": "The dedicated browser does not own its debugging port."}
    try:
        with build_opener(ProxyHandler({})).open(endpoint + "/json/version", timeout=2) as response:
            version = json.loads(response.read(65536))
    except (URLError, HTTPError, TimeoutError, json.JSONDecodeError) as error:
        return {**result, "reason": f"Debugging endpoint unavailable: {error}"}
    if not isinstance(version, dict) or not isinstance(version.get("webSocketDebuggerUrl"), str):
        return {**result, "reason": "Debugging endpoint returned an invalid response."}
    websocket = urlparse(version["webSocketDebuggerUrl"])
    if websocket.scheme != "ws" or websocket.hostname not in ("localhost", "127.0.0.1", "::1") or websocket.port != port(identity):
        return {**result, "reason": "Debugging endpoint identity could not be verified."}
    return {**result, "ready": True, "pid": process["pid"], "headless": process["headless"]}


def install():
    home = Path.home()
    target = home / ".local/bin/harlan-browser"
    target.parent.mkdir(parents=True, exist_ok=True)
    if Path(__file__).resolve() != target.resolve():
        shutil.copyfile(__file__, target)
    target.chmod(0o755)
    applications = home / ".local/share/applications"
    applications.mkdir(parents=True, exist_ok=True)
    for identity in PORTS:
        launcher = applications / f"harlan-chrome-{identity}.desktop"
        launcher.write_text(f"[Desktop Entry]\nType=Application\nName=Chrome {identity.title()} Automation\nExec={target} open {identity} --headed %U\nIcon=google-chrome\nTerminal=false\nCategories=Network;WebBrowser;\n")
        launcher.chmod(0o644)
    print("Installed Clients and Agent Chrome launchers.")


def main(args):
    if args == ["install"]:
        install()
        return
    if len(args) < 2 or args[0] not in ("open", "status", "connect"):
        fail("Use: harlan-browser install, or open|status|connect clients|agent. Open and connect accept --headed.")
    action, identity, *extra = args
    if identity not in PORTS:
        fail("Choose clients or agent.")
    headed = False
    if action in ("open", "connect") and "--headed" in extra:
        headed = True
        extra.remove("--headed")
    root = data_root()
    if any((root / name).is_symlink() for name in PORTS):
        fail("Use distinct Chrome data directories. Profile directory symlinks are not accepted.")
    if port("clients") == port("agent"):
        fail("Clients and Agent must use distinct debugging ports.")
    if action == "status":
        if extra:
            fail("Use: harlan-browser status clients|agent.")
        print(json.dumps(status(identity, root)))
        return
    if action == "connect":
        if len(extra) != 1 or not extra[0] or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for char in extra[0]):
            fail("Provide one task name using letters, numbers, hyphens, or underscores.")
        readiness = status(identity, root)
        if not readiness["ready"]:
            fail(f"{readiness['reason']} Run: harlan-browser open {identity}")
        if not readiness["headless"] and not headed:
            fail("The dedicated browser is visible. Close it, then run "
                 f"harlan-browser open {identity}. Use --headed only for requested visible work.")
        os.execvp("dev-browser", ["dev-browser", "--browser", f"{identity}-{extra[0]}", "--connect", readiness["endpoint"]])
        return
    for url in extra:
        if not url.startswith(("https://", "http://", "chrome://")):
            fail("Provide an http, https, or chrome URL. Browser flags are not accepted.")
    if headed and not os.environ.get("DISPLAY") and not os.environ.get("WAYLAND_DISPLAY"):
        fail("If no desktop session is available, open the launcher on the desktop.")
    process = owner(identity, root)
    if process and not process["debugging"]:
        fail("Close this dedicated browser and reopen its launcher to enable debugging.")
    if process and process["headless"] != (not headed):
        fail("The dedicated browser uses another display mode. Close it before changing modes.")
    if process and not extra:
        # Reusing the process avoids opening a tab or activating its window.
        return
    with socket.socket() as probe:
        busy = probe.connect_ex(("127.0.0.1", port(identity))) == 0
    if busy and (not process or not owns_listener(process["pid"], port(identity))):
        fail(f"Port {port(identity)} belongs to another application. Resolve that conflict before opening Chrome.")
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    root.chmod(0o700)
    directory = root / identity
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    os.execvp("google-chrome", ["google-chrome", f"--user-data-dir={directory}", f"--remote-debugging-port={port(identity)}", "--no-first-run", "--no-default-browser-check", *([] if headed else ["--headless"]), *(extra or ["about:blank"])])


if __name__ == "__main__":
    main(sys.argv[1:])
