import assert from "node:assert";
import { plan, command, lastWords } from "./plan.js";

const texts = (p) => p.todo.map((x) => x.text);

// parent and its children all lost: parent's resume carries the note, children plain
let p = plan([
  { address: "t17", app: "claude", cmd: "claude --resume P" },
  { address: "t1f", app: "claude", cmd: "claude --resume A", parent: "t17", name: "gen448" },
  { address: "t1g", app: "codex", cmd: "codex resume B", parent: "t17" },
]);
assert.equal(p.todo.length, 3);
assert.match(p.todo[0].text, /^claude --resume P '\[agent-resume-plus\].*you were resumed.*t1f \(gen448\), t1g /);
assert.deepEqual(texts(p).slice(1), ["claude --resume A", "codex resume B"]);

// only a child lost, parent alive: child resumed, parent gets an hc send note
p = plan([{ address: "t1j", app: "pi", cmd: "pi --session /x.jsonl", parent: "t17", name: "gen422" }]);
assert.deepEqual(p.todo.map((x) => x.address), ["t1j", "t17"]);
assert.ok(p.todo[1].note);
assert.match(p.todo[1].text, /^\[agent-resume-plus\] The machine restarted\. Your sub-agents t1j \(gen422\)/);

// opencode / pi parents use their own prompt flags; quotes survive the shell
p = plan([
  { address: "a", app: "opencode", cmd: "opencode -s S" },
  { address: "b", app: "pi", cmd: "pi --session F", parent: "a" },
  { address: "c", app: "pi", cmd: "pi --session G" },
  { address: "d", app: "claude", cmd: "claude --resume D", parent: "c", name: "it's" },
]);
assert.match(p.todo[0].text, /^opencode -s S --prompt '/);
assert.match(p.todo[2].text, /^pi --session G -- '/);
assert.ok(p.todo[2].text.includes(`(it'\\''s)`));

// legacy entry without cmd/app
assert.equal(command({ address: "x", session: "Z" }), "claude --resume Z");
// resumed in the agent's folder, quoted
assert.equal(command({ cmd: "claude --resume E", cwd: "/a b/it's" }), "cd '/a b/it'\\''s' && claude --resume E");

// launch flags come back after the resume words, quoted where needed; untypable groups dropped
assert.equal(
  command({ cmd: "claude --resume E", flags: [["--model", "opus"], ["--append-system-prompt", "be brief"], ["--settings", "a\nb"]] }),
  "claude --resume E --model opus --append-system-prompt 'be brief'",
);

// skipped, with a reason; the rest still go
p = plan(
  [
    { address: "o", app: "claude", session: "S1", cmd: "claude --resume S1" },
    { address: "d1", app: "claude", session: "S2", cmd: "claude --resume S2" },
    { address: "d2", app: "claude", session: "S2", cmd: "claude --resume S2" },
    { address: "g", app: "codex", session: "S3", cmd: "codex resume S3", cwd: "/gone" },
    { address: "n", app: "claude", session: "S4", cmd: "claude --resume S4", transcript: "/t/S4.jsonl" },
    { address: "c", app: "claude", session: "S5", cmd: "claude --resume S5", cwd: "/a\nb" },
    { address: "ok", app: "pi", session: "S6", cmd: "pi --session S6", cwd: "/here", transcript: "/t/S6.jsonl" },
  ],
  { open: new Set(["claude:S1"]), folderOk: new Set(["/here", "/a\nb"]), fileOk: new Set(["/t/S6.jsonl"]) },
);
assert.deepEqual(p.skipped.map((s) => [s.address, s.reason]), [
  ["o", "open in another terminal"],
  ["d2", "resumed in another terminal"],
  ["g", "its folder is gone"],
  ["n", "no saved conversation to resume"],
  ["c", "its folder name can't be typed safely"],
]);
assert.deepEqual(p.todo.map((x) => x.address), ["d1", "ok"]);

// a skipped parent doesn't get a resume note; its resumed child's note goes by hc send
p = plan(
  [
    { address: "P", app: "claude", session: "SP", cmd: "claude --resume SP", cwd: "/gone" },
    { address: "K", app: "claude", session: "SK", cmd: "claude --resume SK", parent: "P" },
  ],
  { folderOk: new Set() },
);
assert.deepEqual(p.todo.map((x) => [x.address, Boolean(x.note)]), [["K", false], ["P", true]]);

assert.equal(lastWords("No conversation found with session ID: X\n\n➜ repo git:(main) "), "No conversation found with session ID: X");
assert.equal(lastWords("➜ "), null);

console.log("ok");
