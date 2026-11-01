#!/usr/bin/env python3
"""Print the resumable session of the agent running as <pid> in <cwd>, as JSON:
{"app", "session", "cmd", "flags", "transcript"} or {} when it isn't a known agent
(or has no session yet). `flags`: the launch flags worth passing again on resume, as
groups ([flag, value, ...]); `transcript`: the file holding the conversation, when the
agent keeps one (claude, codex, pi), so a resume can check it's still there.

Usage: agent_session.py <pid> <cwd>   |   agent_session.py status   |   agent_session.py --test

`status` is the dry run: what the mod would type into each tracked terminal if it lost
its agent, and what a resume pass would do right now (from the mod's status.json).
"""
import glob
import json
import os
import re
import shlex
import sqlite3
import sys

HOME = os.path.expanduser("~")

# Launch flags carried over to the resume command, with how many values each takes
# ("+": one or more, up to the next flag). Only flags that set up how the agent runs and
# that its resume command accepts; never ones that pick or start a session, a prompt, or a
# secret (pi's --api-key). The claude and codex tables are from thuanlm215/herdr-agent-resume
# (MIT, Copyright (c) 2026 Herdr Agent Resume contributors); opencode and pi are added here.
KEEP_FLAGS = {
    "claude": {
        "--dangerously-skip-permissions": 0, "--allow-dangerously-skip-permissions": 0,
        "--ide": 0, "--verbose": 0, "--strict-mcp-config": 0, "--chrome": 0, "--no-chrome": 0,
        "--brief": 0, "--disable-slash-commands": 0,
        "--model": 1, "--fallback-model": 1, "--permission-mode": 1, "--agent": 1, "--agents": 1,
        "--settings": 1, "--setting-sources": 1, "--append-system-prompt": 1, "--system-prompt": 1,
        "--effort": 1, "--autocompact": 1, "--plugin-dir": 1,
        "--add-dir": "+", "--allowedTools": "+", "--allowed-tools": "+", "--disallowedTools": "+",
        "--disallowed-tools": "+", "--mcp-config": "+", "--tools": "+", "--betas": "+",
    },
    "codex": {
        "--oss": 0, "--search": 0, "--dangerously-bypass-approvals-and-sandbox": 0,
        "--no-alt-screen": 0, "--approve-for-me": 0,
        "-c": 1, "--config": 1, "-m": 1, "--model": 1, "-p": 1, "--profile": 1, "-s": 1, "--sandbox": 1,
        "-a": 1, "--ask-for-approval": 1, "--add-dir": 1, "--enable": 1, "--disable": 1,
        "--local-provider": 1,
    },
    "opencode": {"--auto": 0, "--standalone": 0, "--server": 1},
    "pi": {
        "--no-tools": 0, "-nt": 0, "--no-builtin-tools": 0, "-nbt": 0, "--no-extensions": 0, "-ne": 0,
        "--no-mcp": 0, "--no-skills": 0, "-ns": 0, "--no-prompt-templates": 0, "-np": 0,
        "--provider": 1, "--model": 1, "--models": 1, "--thinking": 1, "--system-prompt": 1,
        "--append-system-prompt": 1, "--tools": 1, "-t": 1, "--exclude-tools": 1, "-xt": 1,
        "--extension": 1, "-e": 1, "--skill": 1, "--prompt-template": 1, "--theme": 1,
        "--use-theme": 1, "--session-dir": 1,
    },
}
MAX_ARGS, MAX_ARG_LEN = 64, 1024


def launch_flags(app, args):
    """The flags in `args` (argv after the program) worth keeping on resume, as groups."""
    keep, groups, i = KEEP_FLAGS[app], [], 0
    while i < len(args):
        arg = args[i]
        i += 1
        if arg == "--":
            break
        name, eq, _ = arg.partition("=")
        arity = keep.get(name) if name.startswith("-") else None
        if arity is None:
            continue
        if eq or arity == 0:
            if not (eq and arity == 0):
                groups.append([arg])
            continue
        values = []
        # ponytail: a "+" flag stops at a value with a space, taken to be the prompt that follows
        # (`--add-dir /a "fix it"`); a path with a space in such a list is dropped with it.
        while i < len(args) and (not values or (arity == "+" and " " not in args[i])) and not args[i].startswith("-"):
            values.append(args[i])
            i += 1
        if values:
            groups.append([arg, *values])
    kept, size = [], 0
    for g in groups:
        if size + len(g) <= MAX_ARGS and all(len(a) <= MAX_ARG_LEN for a in g):
            kept.append(g)
            size += len(g)
    return kept


def tree(pid):
    out, i = [pid], 0
    while i < len(out):
        for c in glob.glob(f"/proc/{out[i]}/task/*/children"):  # any thread may spawn
            try:
                with open(c) as f:
                    out += [int(k) for k in f.read().split() if int(k) not in out]
            except OSError:
                pass
        i += 1
    return out


def argv(pid):
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            return [a.decode(errors="replace") for a in f.read().split(b"\0") if a]
    except OSError:
        return []


def start_ms(pid):
    with open(f"/proc/{pid}/stat") as f:
        ticks = int(f.read().rsplit(")", 1)[1].split()[19])
    with open("/proc/stat") as f:
        btime = next(int(l.split()[1]) for l in f if l.startswith("btime"))
    return int((btime + ticks / os.sysconf("SC_CLK_TCK")) * 1000)


def flag(args, *names):
    """Value of --name v / --name=v / -n v in args, else None."""
    for i, a in enumerate(args):
        for n in names:
            if a == n and i + 1 < len(args):
                return args[i + 1]
            if a.startswith(n + "="):
                return a[len(n) + 1:]
    return None


def app_of(args):
    """(app, index of the program in args) or (None, None)."""
    for i, a in enumerate(args[:2]):  # the program, or the script node/bun runs
        b = os.path.basename(a)
        if b in ("claude", "codex", "opencode", "pi"):
            return b, i
    return None, None


def pi_dir(cwd):
    return os.path.join(HOME, ".pi/agent/sessions", "--" + cwd.strip("/").replace("/", "-") + "--")


def claude(pids, args, cwd, since):
    for p in pids:
        try:
            with open(f"{HOME}/.claude/sessions/{p}.json") as f:
                sid = json.load(f)["sessionId"]
            t = glob.glob(f"{HOME}/.claude/projects/*/{glob.escape(sid)}.jsonl")
            return sid, f"claude --resume {shlex.quote(sid)}", t[0] if t else None
        except (OSError, ValueError, KeyError):
            continue
    return None


def codex(pids, args, cwd, since):
    # The TUI's app-server child keeps the rollout file of its thread open.
    found = {}
    for p in pids:
        for fd in glob.glob(f"/proc/{p}/fd/*"):
            try:
                t = os.readlink(fd)
            except OSError:
                continue
            m = re.search(r"rollout-.*-([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$", t)
            if m:
                found[m.group(1)] = t
    best = None
    for sid, path in found.items():
        try:
            with open(path) as f:
                meta = json.loads(f.readline())["payload"]
            if meta.get("cwd") != cwd:
                continue
            mt = os.path.getmtime(path)
        except (OSError, ValueError, KeyError):
            continue
        if best is None or mt > best[0]:
            best = (mt, sid, path)
    return (best[1], f"codex resume {best[1]}", best[2]) if best else None


def opencode(pids, args, cwd, since):
    sid = flag(args, "--session", "-s")
    if not sid:
        # ponytail: newest top-level session in this folder since the process started;
        # two opencodes in one folder can swap. Fine until that happens.
        db = f"{HOME}/.local/share/opencode/opencode.db"
        try:
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2)
            row = con.execute(
                "select id from session_v2 where directory=? and parent_id is null and time_archived is null"
                " and time_updated>=? order by time_updated desc limit 1", (cwd, since)).fetchone()
            con.close()
        except sqlite3.Error:
            row = None
        sid = row[0] if row else None
    return (sid, f"opencode -s {shlex.quote(sid)}", None) if sid else None


def pi(pids, args, cwd, since):
    sid = flag(args, "--session")
    if not sid:
        # ponytail: newest session file in this folder's dir written since start (same caveat as opencode).
        files = [f for f in glob.glob(os.path.join(pi_dir(cwd), "*.jsonl")) if os.path.getmtime(f) * 1000 >= since]
        sid = max(files, key=os.path.getmtime) if files else None
    return (sid, f"pi --session {shlex.quote(sid)}", sid if os.path.isabs(sid) else None) if sid else None


FIND = {"claude": claude, "codex": codex, "opencode": opencode, "pi": pi}


def detect(pid, cwd):
    pids = tree(pid)
    for p in pids:
        args = argv(p)
        app, i = app_of(args)
        if app:
            r = FIND[app](pids, args, cwd, start_ms(pid))
            if not r:
                return {}
            return {"app": app, "session": r[0], "cmd": r[1], "transcript": r[2],
                    "flags": launch_flags(app, args[i + 1:])}
    return {}


def test():
    assert flag(["opencode", "-s", "ses_1"], "--session", "-s") == "ses_1"
    assert flag(["pi", "--session=/a b.jsonl"], "--session") == "/a b.jsonl"
    assert flag(["pi", "--sessions", "x"], "--session") is None
    assert app_of(["node", "/x/bin/codex"]) == ("codex", 1)
    assert app_of(["/usr/bin/zsh"]) == (None, None)
    # flags: kept with their values; prompts, session pickers, unknown flags and secrets dropped
    assert launch_flags("claude", ["--model", "opus", "--resume", "X", "--dangerously-skip-permissions",
                                   "--add-dir", "/a", "/b", "fix it"]) == [
        ["--model", "opus"], ["--dangerously-skip-permissions"], ["--add-dir", "/a", "/b"]]
    assert launch_flags("codex", ["-m", "gpt-5", "-s", "workspace-write", "--full-auto", "do x"]) == [
        ["-m", "gpt-5"], ["-s", "workspace-write"]]
    assert launch_flags("pi", ["--api-key", "SECRET", "--model", "x", "--thinking=high", "-p"]) == [
        ["--model", "x"], ["--thinking=high"]]
    assert launch_flags("opencode", ["--auto", "-s", "ses_1", "--prompt", "hi"]) == [["--auto"]]
    assert launch_flags("claude", ["--verbose=1", "--", "--model", "x"]) == []
    assert pi_dir("/home/manas").endswith("/.pi/agent/sessions/--home-manas--")
    assert detect(os.getpid(), os.getcwd()) == {}
    print("ok")


def status(home=None):
    home = home or os.environ.get("HERDR_APP_HOME") or os.path.join(HOME, ".config/herdr-app")
    try:
        with open(os.path.join(home, "data/agent-resume-plus/status.json")) as f:
            st = json.load(f)
    except (OSError, ValueError):
        print("No status yet: is the agent-resume-plus block in your layout, and Herdr app running?")
        return 1
    print(f"Tracked: {len(st.get('tracked', []))}")
    for t in st.get("tracked", []):
        print(f"  {t['address']:>5}  {t.get('where') or ''}\n         {t.get('command') or '(folder name not typable: would be skipped)'}")
    todo, skipped = st.get("resumable", []), st.get("skipped", [])
    print(f"\nA resume pass now would type into {len(todo)}, skip {len(skipped)}.")
    for t in todo:
        print(f"  {t['address']:>5}  {t.get('where') or ''}: {t['text']}")
    for t in skipped:
        print(f"  {t['address']:>5}  {t.get('where') or ''}: skipped, {t['reason']}")
    return 0


if __name__ == "__main__":
    if sys.argv[1:] == ["--test"]:
        test()
    elif sys.argv[1:] == ["status"]:
        sys.exit(status())
    else:
        print(json.dumps(detect(int(sys.argv[1]), sys.argv[2])))
