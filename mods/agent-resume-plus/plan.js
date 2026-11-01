// What to type where, for a set of lost terminals. Pure, so `node plan.test.mjs` checks it.
//
// Sub-agent links (parent, name) live in herdr-core and survive a reboot with the
// same addresses, so `hc send <parent>` and `hc wait --children` still route. What
// a reboot loses is the parent's awareness: its own waits died and its children
// came back idle. So each parent of resumed children gets a note:
// - parent resumed too: as the first message of its resume command (no boot race),
// - parent still alive: by `hc send`.

// Typed into a shell: anything but control characters (a newline would run the line early).
const TYPABLE = /^[^\x00-\x1f\x7f]*$/;
const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;
const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const word = (s) => (SAFE.test(s) ? s : q(s));

const PROMPT = {
  claude: (m) => ` ${q(m)}`,
  codex: (m) => ` ${q(m)}`,
  opencode: (m) => ` --prompt ${q(m)}`,
  pi: (m) => ` -- ${q(m)}`,
};

function note(kids, selfLost) {
  const list = kids.map((k) => (k.name ? `${k.address} (${k.name})` : k.address)).join(", ");
  return (
    `[agent-resume-plus] The machine restarted${selfLost ? " and you were resumed from your saved session" : ""}. ` +
    `Your sub-agents ${list} were resumed from their saved sessions at the same addresses, ` +
    `but any in-flight work, background commands and hc waits were lost. ` +
    `Check each with hc read <t>, re-send unfinished tasks with hc send <t>, then hc wait --children.`
  );
}

/** The command to type for one entry, or null when its folder can't be typed safely. */
export function command(l) {
  // The restored shell may start elsewhere, and `claude --resume` only finds the session in its folder.
  if (l.cwd && !(l.cwd.startsWith("/") && TYPABLE.test(l.cwd))) return null;
  const flags = (l.flags ?? []).filter((g) => g.every((a) => TYPABLE.test(a))).flat().map(word);
  const base = l.cmd ?? `claude --resume ${l.session}`;
  return (l.cwd ? `cd ${q(l.cwd)} && ` : "") + [base, ...flags].join(" ");
}

/**
 * lost: [{address, app, cmd, session, cwd, flags, transcript, parent, name, where}]
 * ctx:  {open: Set("app:session") running in another terminal, folderOk / fileOk: Sets of
 *        the cwds / transcripts that still exist (left out: not checked)}
 * -> {todo: [{address, where, text, note?}] in send order, skipped: [{address, where, reason}]}
 */
export function plan(lost, ctx = {}) {
  const { open = new Set(), folderOk, fileOk } = ctx;
  const go = [], skipped = [], taken = new Set();
  for (const l of lost) {
    const key = `${l.app ?? "claude"}:${l.session ?? l.address}`;
    const text = command(l);
    const reason =
      open.has(key) ? "open in another terminal"
      : taken.has(key) ? "resumed in another terminal"
      : l.cwd && folderOk && !folderOk.has(l.cwd) ? "its folder is gone"
      : l.transcript && fileOk && !fileOk.has(l.transcript) ? "no saved conversation to resume"
      : text === null ? "its folder name can't be typed safely"
      : null;
    if (reason) skipped.push({ address: l.address, where: l.where, reason });
    else { taken.add(key); go.push({ ...l, text }); }
  }
  const kids = {};
  for (const l of go) if (l.parent) (kids[l.parent] ??= []).push(l);
  const going = new Set(go.map((l) => l.address));
  const todo = go.map((l) => ({
    address: l.address, where: l.where,
    text: kids[l.address] ? l.text + (PROMPT[l.app] ?? PROMPT.claude)(note(kids[l.address], true)) : l.text,
  }));
  for (const [parent, ks] of Object.entries(kids)) {
    if (!going.has(parent)) todo.push({ address: parent, note: true, text: note(ks, false) });
  }
  return { todo, skipped };
}

/** The last line an agent printed before the shell's prompt came back, or null. */
export function lastWords(screen) {
  const lines = (screen ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  return lines.length >= 2 ? lines[lines.length - 2].slice(0, 160) : null;
}
