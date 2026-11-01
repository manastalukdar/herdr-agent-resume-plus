import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { hc, exec, theme, appHome, readTextFile, writeTextFile, notify, props, closeOverlay } from "herdr";
import { plan, command, lastWords } from "./plan.js";

// What the herdr TUI did and the app doesn't: remember which agent session each
// terminal runs (Claude Code, Codex, opencode, pi), and resume it after a reboot
// gives the terminal back as a shell.
//
// Map: address -> { app, session, cmd, flags, transcript, pid, created, boot, cwd, where,
// parent, name }. `pid` is the terminal's own shell pid; parent/name are the sub-agent link
// (see plan.js for how it's restored); `flags` the launch flags passed again on resume.
// - An agent in the foreground: agent_session.py finds its current session and the
//   command that resumes it.
// - Shell in the foreground, same shell pid: you quit Claude on purpose -> forget it.
// - Shell in the foreground of a re-created terminal (other created_ms; older entries:
//   other shell pid): the terminal was lost -> resumable. Typed back automatically
//   when the mod starts only after a real reboot (boot_id changed); after a core
//   restart alone it waits for the Resume button. Resumed in the agent's folder.
// - Terminal gone from `hc ls`: tab closed -> forget it.
// ponytail: local machine only, add `--on <machine>` per space if remote agents matter.

const POLL_MS = 15000;
// ponytail: an agent's session is re-read only when its turn, status or process changed,
// or every FULL_EVERY polls (~5 min) to catch a /clear or /resume between turns.
const FULL_EVERY = 20;
const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "nu", "pwsh"]);
const START_WAIT_S = 12; // after a reboot, how long to wait for restored shells to start
const SETTLE_MS = 1500; // a restored shell runs this long before anything is typed into it
const VERIFY_S = 5; // after typing, how long agents get before we check they came up
// The resume pass (flags, skips with reasons, the wait for shells, the check that each
// agent came up) follows thuanlm215/herdr-agent-resume (MIT).

// ponytail: no setTimeout in mods; a sleep process is the simplest wait inside cx.spawn.
const sleep = (s) => exec("/bin/sleep", [String(s)]);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const LOG_MAX = 256 * 1024; // log.jsonl rolls over to log.jsonl.1 past this

async function json(args) {
  const r = await hc([...args, "--json"]);
  return r.code === 0 ? JSON.parse(r.stdout) : null;
}

export default class AgentResume extends View {
  init(_props, cx) {
    // Opened by its key (`mod.open:agent-resume-plus`) it's a popup: one manual pass, then it closes.
    this.overlay = props()?.overlay ?? null;
    this.dir = `${appHome()}/data/agent-resume-plus`;
    this.file = `${this.dir}/map.json`;
    this.helper = `${appHome()}/mods/agent-resume-plus/agent_session.py`;
    this.map = {};
    this.raw = null;
    this.lost = [];
    this.error = null;
    this.autoDone = false;
    this.seenKey = {}; // address -> fg pid|turn|status at the last helper run
    this.polls = 0;
    cx.spawn(async (cx) => {
      const b = await exec("/bin/cat", ["/proc/sys/kernel/random/boot_id"]);
      this.boot = b.code === 0 ? b.stdout.trim() : null;
      this.raw = await readTextFile(this.file);
      try { this.map = this.raw ? JSON.parse(this.raw) : {}; } catch { this.map = {}; }
      await this.poll(cx);
      if (this.overlay) {
        if (this.lost.length) await this.resume(cx, false);
        else notify({ title: "No agent sessions to resume", level: "info" });
        closeOverlay(this.overlay);
        return;
      }
      // Shells a reboot restores can still be starting: give them a moment before deciding.
      for (let i = 0; this.pending > 0 && i < START_WAIT_S; i++) {
        await sleep(1);
        await this.poll(cx);
      }
      if (this.lost.length) await this.resume(cx, true);
      this.autoDone = true;
      cx.notify();
    });
    if (!this.overlay) cx.timer.every(POLL_MS, (cx) => cx.spawn((cx) => this.poll(cx)));
  }

  async poll(cx) {
    if (this.busy) return;
    this.busy = true;
    try {
      const ls = await json(["ls"]);
      if (!ls) throw new Error("hc ls failed");
      const live = ls.terminals.filter((t) => t.state === "live");
      const seen = new Set();
      const lost = [];
      let pending = 0;
      const full = this.polls++ % FULL_EVERY === 0;
      for (const t of live) {
        seen.add(t.address);
        const known = this.map[t.address];
        // A bare shell we don't track: nothing to do. (Not "no status": herdr may not
        // recognise every agent, and pi/opencode must still be found.)
        if (!known && SHELLS.has(t.agent)) continue;
        const g = await json(["get", t.address]);
        if (!g) continue;
        const fg = g.foreground;
        if (known && !fg) pending++; // tracked, but its shell hasn't started yet
        const key = `${fg?.pid}|${t.turn}|${t.status}`;
        if (!full && known && fg && fg.pid !== g.pid && this.seenKey[t.address] === key) continue;
        this.seenKey[t.address] = key;
        // Ask even when fg is the terminal's own process: `hc run claude` has no shell.
        const r = fg ? await exec("/usr/bin/python3", ["-I", this.helper, String(fg.pid), fg.cwd]) : null;
        const s = r?.code === 0 ? JSON.parse(r.stdout) : {};
        if (s.cmd) {
          this.map[t.address] = { ...s, pid: g.pid, created: g.created_ms, boot: this.boot, cwd: fg.cwd,
            where: t.where, parent: g.parent ?? null, name: g.name ?? null };
        } else if (known && fg && fg.pid === g.pid) {
          const same = known.created ? known.created === g.created_ms : known.pid === g.pid;
          if (same) { // quit on purpose
            delete this.map[t.address];
            this.log("forget", known, t.address);
          }
          else lost.push({ address: t.address, ...known });
        }
      }
      for (const a of Object.keys(this.map)) if (!seen.has(a)) delete this.map[a];
      for (const a of Object.keys(this.seenKey)) if (!seen.has(a)) delete this.seenKey[a];
      this.lost = lost;
      this.pending = pending;
      await this.save();
      await this.writeStatus();
      this.error = null;
    } catch (e) {
      this.error = String(e?.message ?? e);
    } finally {
      this.busy = false;
    }
    cx.notify();
  }

  // One line per event in data/agent-resume-plus/log.jsonl.
  async log(event, e, address, reason) {
    const line = JSON.stringify({ at: new Date().toISOString(), event, terminal: address, where: e?.where,
      app: e?.app, session: e?.session, ...(reason ? { reason } : {}) });
    await exec("/bin/sh", ["-c", 'f="$1/log.jsonl"; [ -f "$f" ] && [ "$(wc -c < "$f")" -gt "$3" ] && mv "$f" "$f.1"; printf "%s\\n" "$2" >> "$f"',
      "sh", this.dir, line, String(LOG_MAX)]);
  }

  // What a pass would do, for `agent_session.py status` (the dry run): every tracked
  // session with the command a resume would type, and the lost ones as a pass sees them.
  async writeStatus() {
    const tracked = Object.entries(this.map).map(([address, e]) => ({ address, where: e.where, app: e.app, session: e.session, command: command(e) }));
    const ctx = this.lost.length ? await this.context(this.lost) : {};
    const { todo, skipped } = plan(this.lost, ctx);
    const text = JSON.stringify({ boot: this.boot, tracked, resumable: todo, skipped }, null, 2);
    if (text === this.statusText) return;
    this.statusText = text;
    const old = await readTextFile(`${this.dir}/status.json`);
    await writeTextFile(`${this.dir}/status.json`, text, old).catch(() => {});
  }

  // Which of these entries' folders and transcripts still exist, and which sessions run elsewhere.
  async context(pick) {
    const lostAt = new Set(this.lost.concat(pick).map((l) => l.address));
    const open = new Set(Object.entries(this.map).filter(([a]) => !lostAt.has(a)).map(([, e]) => `${e.app ?? "claude"}:${e.session}`));
    const paths = [...new Set(pick.flatMap((l) => [l.cwd, l.transcript]).filter(Boolean))];
    const ex = paths.length ? await exec("/bin/sh", ["-c", 'for p; do [ -e "$p" ] && printf "%s\\0" "$p"; done; true', "sh", ...paths]) : null;
    const exists = new Set((ex?.stdout ?? "").split("\0").filter(Boolean));
    return { open, folderOk: exists, fileOk: exists };
  }

  async save() {
    const text = JSON.stringify(this.map, null, 2);
    if (text === this.raw) return;
    try {
      await writeTextFile(this.file, text, this.raw);
    } catch {
      // stale snapshot (another copy wrote): take theirs as the base and overwrite
      this.raw = await readTextFile(this.file);
      await writeTextFile(this.file, text, this.raw);
    }
    this.raw = text;
  }

  async resume(cx, auto) {
    // Auto: only what a reboot lost. A core restart alone, or an entry from before
    // boot ids were saved, stays on the Resume button.
    const pick = auto ? this.lost.filter((l) => this.boot && l.boot && l.boot !== this.boot) : this.lost;
    if (!pick.length) return;
    const { todo, skipped } = plan(pick, await this.context(pick));
    this.lost = this.lost.filter((l) => !pick.includes(l));
    cx.notify();

    const sent = [];
    for (const s of todo) {
      if (!s.note) {
        const g = await json(["get", s.address]);
        if (!g?.foreground || g.foreground.pid !== g.pid) {
          skipped.push({ address: s.address, where: s.where, reason: "something else is running there" });
          continue;
        }
        const age = Date.now() - (g.created_ms ?? 0);
        if (age < SETTLE_MS) await sleep((SETTLE_MS - age) / 1000);
      }
      const r = await hc(["send", s.address, s.text]);
      if (r.code !== 0) skipped.push({ address: s.address, where: s.where, reason: `couldn't type into it: ${(r.stderr || r.stdout).trim()}` });
      else if (!s.note) sent.push(s);
    }
    // An agent that exited right away leaves its shell in front again.
    const done = [];
    if (sent.length) {
      await sleep(VERIFY_S);
      for (const s of sent) {
        const g = await json(["get", s.address]);
        if (g?.foreground && g.foreground.pid === g.pid) {
          const r = await hc(["read", s.address]);
          const said = r.code === 0 ? lastWords(r.stdout) : null;
          skipped.push({ address: s.address, where: s.where, reason: said ? `exited right away: ${said}` : "exited right away" });
        } else done.push(s);
      }
    }
    const byAddr = Object.fromEntries(pick.map((l) => [l.address, l]));
    for (const s of done) await this.log("resume", byAddr[s.address], s.address);
    for (const s of skipped) await this.log(s.reason.startsWith("exited") ? "fail" : "skip", byAddr[s.address], s.address, s.reason);
    if (done.length || skipped.length) {
      const name = (x) => x.where ?? x.address;
      notify({
        title: done.length
          ? `${auto ? "Auto-resumed" : "Resumed"} ${plural(done.length, "agent session")}` + (skipped.length ? `, ${skipped.length} not` : "")
          : `Couldn't resume ${plural(skipped.length, "agent session")}`,
        body: [...done.map(name), ...skipped.map((x) => `${name(x)}: ${x.reason}`)].join("\n"),
        level: skipped.length ? "warning" : "success",
      });
    }
    cx.notify();
  }

  render() {
    const t = theme();
    if (this.overlay) {
      return div().id("root").size_full().p(16).flex().items_center().justify_center().bg(t.background)
        .text_size(13).text_color(t.foreground).child("Looking for agent sessions to resume…");
    }
    const tracked = Object.keys(this.map).length;
    const n = this.lost.length;
    return h_flex().id("root").size_full().px(12).gap(10).items_center().justify_end()
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(div().text_color(this.error ? t.blocked : t.dim)
        .child(this.error ? `resume: ${this.error}` : `↻ ${tracked} agents tracked`))
      .when(n > 0, (el) => el.child(
        div().id("resume").cursor_pointer().px(8).rounded(4).bg(t.accent).text_color(t.accent_foreground)
          .hover((s) => s.opacity(0.85))
          .on_click((_e, cx) => cx.spawn((cx) => this.resume(cx, false)))
          .child(`Resume ${n}`)));
  }
}
