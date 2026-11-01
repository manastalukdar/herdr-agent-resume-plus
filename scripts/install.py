#!/usr/bin/env python3
"""Install agent-resume-plus into Herdr app.

  python3 scripts/install.py              install
  python3 scripts/install.py --update     copy the mod over an earlier install
  python3 scripts/install.py --uninstall  take it out of your layouts and keys, remove the mod
  add --dry-run to any of them to see what would change

It copies mods/agent-resume-plus, binds alt-shift-r to a manual resume pass (refusing
a key already in use), and adds the mod's 230px block at the right of the current
layout's status bar: it has to run in the background to resume after a reboot. Herdr's
own layouts (main, ...) are replaced on every start, so one of those is cloned first as
<name>-resume (and switched to); a layout of your own is edited in place, after a backup
in data/agent-resume-plus/backups/.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MOD = "agent-resume-plus"
STATUS = "workspace-status"
GENERATED = ("gpui-kit.d.ts", "herdr.d.ts", "jsconfig.json", "__pycache__")
BLOCK = {"id": MOD, "type": "block", "content": {"mod": MOD}, "size": {"px": 230}}


def herdr(*args):
    r = subprocess.run(["herdr-app", *args], capture_output=True, text=True, timeout=30)
    if r.returncode:
        sys.exit(f"herdr-app {' '.join(args)} failed:\n{r.stdout}{r.stderr}")
    return r.stdout


def has_mod(node, name):
    if isinstance(node, dict):
        if node.get("type") == "block" and node.get("content", {}).get("mod") == name:
            return True
        return any(has_mod(v, name) for v in node.values())
    return isinstance(node, list) and any(has_mod(v, name) for v in node)


def add_block(node):
    """Put BLOCK next to the status bar: into its row if it already has one, else wrap the
    status block in a row. True when added."""
    if isinstance(node, dict):
        kids = node.get("children")
        if isinstance(kids, list):
            for i, c in enumerate(kids):
                if isinstance(c, dict) and c.get("type") == "block" and c.get("content", {}).get("mod") == STATUS:
                    if node.get("type") == "row":
                        kids.append(dict(BLOCK))
                    else:
                        kids[i] = {"id": c.get("id", "status"), "type": "row", "size": c.get("size", {"px": 28}),
                                   "children": [{**c, "id": f"{c.get('id', 'status')}-original", "size": {"weight": 1}}, dict(BLOCK)]}
                    return True
        return any(add_block(v) for v in node.values())
    return isinstance(node, list) and any(add_block(v) for v in node)


def drop_block(node):
    """Remove every BLOCK; a status row left with only the status block is unwrapped. Count removed."""
    n = 0
    if isinstance(node, list):
        return sum(drop_block(v) for v in node)
    if not isinstance(node, dict):
        return 0
    for v in node.values():  # children first, so a row is emptied before we look at it
        n += drop_block(v)
    kids = node.get("children")
    if isinstance(kids, list):
        keep = [c for c in kids if not (isinstance(c, dict) and c.get("content", {}).get("mod") == MOD)]
        n += len(kids) - len(keep)
        for i, c in enumerate(keep):
            ck = c.get("children") if isinstance(c, dict) else None
            if c.get("type") == "row" and isinstance(ck, list) and len(ck) == 1 and ck[0].get("content", {}).get("mod") == STATUS \
                    and str(ck[0].get("id", "")).endswith("-original"):
                keep[i] = {**ck[0], "id": c.get("id"), "size": c.get("size")}
        node["children"] = keep
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--update", action="store_true")
    ap.add_argument("--uninstall", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    home = Path(os.environ.get("HERDR_APP_HOME", Path.home() / ".config/herdr-app"))
    if not (home / "layouts").is_dir():
        sys.exit(f"No Herdr app home at {home}. Start Herdr app once, or set HERDR_APP_HOME.")
    shipped = set(json.loads((home / "installed.json").read_text())) if (home / "installed.json").exists() else set()
    dry = "(dry run) " if a.dry_run else ""
    keys_path = home / "keys.json"
    keys = json.loads(keys_path.read_text()) if keys_path.exists() else {}
    ours = json.loads((REPO / "keys.json").read_text())

    if a.uninstall:
        for f in sorted((home / "layouts").glob("*.json")):
            if f"layout:{f.stem}" in shipped:
                continue
            tree = json.loads(f.read_text())
            if n := drop_block(tree):
                print(f"{dry}{f.name}: removed the {MOD} block")
                if not a.dry_run:
                    f.write_text(json.dumps(tree, indent=2) + "\n")
        for section, binds in ours.items():
            for key, action in binds.items():
                if keys.get(section, {}).get(key) == action:
                    print(f"{dry}keys.json: unbind {key}")
                    del keys[section][key]
        if not a.dry_run:
            keys_path.write_text(json.dumps(keys, indent=2) + "\n")
        if (home / "mods" / MOD).exists():
            print(f"{dry}remove mods/{MOD}")
            if not a.dry_run:
                shutil.rmtree(home / "mods" / MOD)
        print(f"Kept: data/{MOD}/ (tracked sessions, log) and any <name>-resume layout the installer cloned.")
        return

    dest = home / "mods" / MOD
    if dest.exists() and not a.update:
        sys.exit(f"mods/{MOD} already exists. Use --update to copy over it.")
    if a.update and not dest.exists():
        sys.exit(f"mods/{MOD} isn't installed yet: run without --update.")
    herdr("check", str(REPO / "mods" / MOD))
    print(f"{dry}copy mods/{MOD}")
    if not a.dry_run:
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(REPO / "mods" / MOD, dest, ignore=shutil.ignore_patterns(*GENERATED))
        herdr("check", str(dest))
    if a.update:
        print("Updated.")
        return

    for section, binds in ours.items():
        for key, action in binds.items():
            have = keys.get(section, {}).get(key)
            if have and have != action:
                print(f"keys.json: {key} is already {have}; not bound. Bind another key to {action} by hand.")
            elif not have:
                print(f"{dry}keys.json: bind {key} to {action}")
                keys.setdefault(section, {})[key] = action
    if not a.dry_run:
        keys_path.write_text(json.dumps(keys, indent=2) + "\n")

    try:
        layout = json.loads((home / "shared.json").read_text()).get("layout") or "main"
    except (OSError, ValueError):
        layout = "main"
    path = home / "layouts" / f"{layout}.json"
    if not path.exists():
        sys.exit(f"Can't find the current layout ({path}). Add a block with \"mod\": \"{MOD}\" to your layout by hand.")
    tree = json.loads(path.read_text())
    if has_mod(tree, MOD):
        print(f"Layout '{layout}' already has the {MOD} block.")
        return
    if not add_block(json.loads(path.read_text())):
        print(f"Layout '{layout}' has no {STATUS} block. Add a block with \"mod\": \"{MOD}\" (about 230px wide) by hand.")
        return
    if f"layout:{layout}" in shipped:
        clone = f"{layout}-resume"
        if (home / "layouts" / f"{clone}.json").exists():
            sys.exit(f"layouts/{clone}.json already exists. Switch to it, or delete it and run again.")
        print(f"{dry}'{layout}' is Herdr's own: clone it as '{clone}' and switch to it")
        if a.dry_run:
            return
        herdr("do", "layout.clone", json.dumps({"name": layout, "as": clone}))
        path = home / "layouts" / f"{clone}.json"
        tree = json.loads(path.read_text())
    elif not a.dry_run:
        backup = home / "data" / MOD / "backups" / f"{layout}.{time.strftime('%Y%m%d-%H%M%S')}.json"
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, backup)
        print(f"backed up {path.name} to {backup}")
    add_block(tree)
    print(f"{dry}{path.name}: {MOD} block added at the right of the status bar")
    if not a.dry_run:
        path.write_text(json.dumps(tree, indent=2) + "\n")


if __name__ == "__main__":
    main()
