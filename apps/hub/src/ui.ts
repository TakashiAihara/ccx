// 止まった session を選んで元のマシンで開き直す人向けのページ (#261)。HTML 1 枚に
// style も script も入れる。CSP が他の origin を禁じるので、外からは何も読まない。
// token は人が入力欄に入れ、この page には埋め込まない。
export const UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ccx stopped sessions</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --fg: #1d1f21;
  --muted: #5f6672;
  --line: #d0d7de;
  --accent: #0b57d0;
  --bad: #b42318;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #16181c;
    --fg: #e6e8eb;
    --muted: #9aa3ad;
    --line: #2f353d;
    --accent: #7aa7ff;
    --bad: #ff8a80;
  }
}
:root[data-theme="dark"] {
  --bg: #16181c;
  --fg: #e6e8eb;
  --muted: #9aa3ad;
  --line: #2f353d;
  --accent: #7aa7ff;
  --bad: #ff8a80;
}
[hidden] { display: none !important; }
body {
  margin: 0;
  padding: 16px;
  background: var(--bg);
  color: var(--fg);
  font: 14px/1.5 system-ui, sans-serif;
}
h1 { font-size: 18px; margin: 0 0 12px; }
.bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
input {
  font: inherit;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--bg);
  color: var(--fg);
  min-width: 0;
}
input[type="search"] { flex: 1 1 14rem; max-width: 100%; }
button {
  font: inherit;
  padding: 5px 10px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: transparent;
  color: var(--fg);
  cursor: pointer;
}
button.primary { border-color: var(--accent); color: var(--accent); }
button:disabled { opacity: 0.5; cursor: default; }
.msg { margin: 8px 0; color: var(--muted); }
.msg.err { color: var(--bad); }
.scroll {
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: 6px;
}
table { border-collapse: collapse; width: max-content; min-width: 100%; }
th, td {
  text-align: left;
  vertical-align: top;
  padding: 6px 8px;
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
}
th { color: var(--muted); font-weight: 600; }
td.wrap { white-space: normal; overflow-wrap: anywhere; max-width: 28rem; }
.state { margin-top: 4px; font-size: 12px; color: var(--muted); white-space: normal; overflow-wrap: anywhere; max-width: 22rem; }
</style>
</head>
<body>
<h1>ccx: stopped sessions</h1>

<section id="gate" hidden>
  <p class="msg">Enter the center token (CCX_CENTER_TOKEN). It is kept in this browser only.</p>
  <div class="bar">
    <input id="token-in" type="password" autocomplete="off" aria-label="center token">
    <button id="save-token" class="primary" type="button">Save token</button>
  </div>
  <p id="gate-msg" class="msg err"></p>
</section>

<section id="app" hidden>
  <div class="bar">
    <input id="search" type="search" placeholder="filter by label, task, cwd, machine, user or session id" aria-label="filter">
    <button id="refresh" type="button">Refresh</button>
    <button id="forget" type="button">Forget token</button>
  </div>
  <p id="list-msg" class="msg"></p>
  <div class="scroll">
    <table>
      <thead>
        <tr>
          <th>Open</th>
          <th>label</th>
          <th>task</th>
          <th>cwd</th>
          <th>machine</th>
          <th>user</th>
          <th>last seen</th>
          <th>session</th>
        </tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
</section>

<script>
(() => {
  "use strict";
  const TOKEN_KEY = "ccx-center-token";
  const WAIT_SECONDS = 40;
  const POLL_MS = 2000;
  const GIVE_UP_MS = 300000;
  const REFRESH_MS = 30000;

  const $ = (id) => document.getElementById(id);
  const gate = $("gate");
  const app = $("app");
  const tokenIn = $("token-in");
  const gateMsg = $("gate-msg");
  const search = $("search");
  const listMsg = $("list-msg");
  const rows = $("rows");

  let sessions = [];
  // 行ごとの依頼の表示。更新で消さないために、一覧の再描画とは別に持つ
  let jobs = {};
  // token が消えたら増やす。古い poll は世代が違えば止まる
  let gen = 0;

  const token = () => localStorage.getItem(TOKEN_KEY) || "";

  function showGate(msg) {
    gen++;
    jobs = {};
    app.hidden = true;
    gate.hidden = false;
    gateMsg.textContent = msg;
    tokenIn.focus();
  }

  function showApp() {
    gate.hidden = true;
    gateMsg.textContent = "";
    app.hidden = false;
  }

  function refused() {
    localStorage.removeItem(TOKEN_KEY);
    showGate("the center refused the token");
  }

  function rpc(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token() },
      body: JSON.stringify(body),
    })
      .then((res) =>
        res.text().then((text) => {
          if (!res.ok) throw { status: res.status, text };
          return text ? JSON.parse(text) : {};
        }),
      )
      .catch((e) => {
        throw e.status ? e : { status: 0, text: String(e) };
      });
  }

  const errText = (e) =>
    e.status ? "error: " + e.status + " " + e.text.slice(0, 200) : "error: " + (e.text || e.message);

  // 小数部の桁数に左右されないよう、落としてから Date.parse に渡す
  const when = (s) => Date.parse((s.lastSeen || "").replace(/\.\d+Z$/, "Z")) || 0;

  const ago = (s) => {
    if (!s.lastSeen) return "—";
    const sec = Math.max(0, Math.floor((Date.now() - when(s)) / 1000));
    if (sec < 60) return sec + "s";
    if (sec < 3600) return Math.floor(sec / 60) + "m";
    if (sec < 86400) return Math.floor(sec / 3600) + "h";
    return Math.floor(sec / 86400) + "d";
  };

  const rowKey = (k) => JSON.stringify([k.machine, k.user, k.sessionId]);

  function cell(text, cls) {
    const td = document.createElement("td");
    td.textContent = text;
    if (cls) td.className = cls;
    return td;
  }

  function rowFor(s) {
    const st = s.state || {};
    const job = jobs[rowKey(s.key)] || { text: "", busy: false };

    const open = document.createElement("td");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Open";
    btn.disabled = job.busy;
    btn.addEventListener("click", () => openSession(s));
    open.append(btn);
    if (job.text) {
      const note = document.createElement("div");
      note.className = "state";
      note.textContent = job.text;
      open.append(note);
    }

    const sid = cell(s.key.sessionId.slice(0, 8));
    sid.title = s.key.sessionId;

    const tr = document.createElement("tr");
    tr.append(
      open,
      cell(st.label || "—", "wrap"),
      cell(st.task || "", "wrap"),
      cell(s.cwd || "", "wrap"),
      cell(s.key.machine),
      cell(s.key.user),
      cell(ago(s)),
      sid,
    );
    return tr;
  }

  function render() {
    const q = search.value.trim().toLowerCase();
    const shown = sessions.filter((s) => {
      if (!q) return true;
      const st = s.state || {};
      return [st.label, st.task, s.cwd, s.key.machine, s.key.user, s.key.sessionId].some((v) =>
        (v || "").toLowerCase().includes(q),
      );
    });
    rows.textContent = "";
    for (const s of shown) rows.append(rowFor(s));
  }

  function setJob(rk, text, busy) {
    jobs[rk] = { text, busy };
    render();
  }

  async function load() {
    if (!token()) return;
    // the first list takes seconds on a large center; an empty table alone reads as broken
    if (!sessions.length) {
      listMsg.className = "msg";
      listMsg.textContent = "loading...";
    }
    try {
      const data = await rpc("/ccx.v1.FleetService/ListSessions", { stoppedOnly: true, limit: 500 });
      sessions = (data.sessions || []).sort((a, b) => when(b) - when(a));
      listMsg.className = "msg";
      listMsg.textContent = sessions.length ? "" : "no stopped sessions";
      render();
    } catch (e) {
      if (e.status === 401) return refused();
      listMsg.className = "msg err";
      listMsg.textContent = errText(e);
    }
  }

  async function openSession(s) {
    const rk = rowKey(s.key);
    const g = gen;
    setJob(rk, "requested", true);
    try {
      const data = await rpc("/ccx.v1.ResumeService/RequestResume", { key: s.key, waitSeconds: WAIT_SECONDS });
      if (g !== gen) return;
      poll(rk, s.key, data.request.id, g, Date.now());
    } catch (e) {
      if (g !== gen) return;
      if (e.status === 401) return refused();
      setJob(rk, errText(e), false);
    }
  }

  function poll(rk, key, id, g, started) {
    rpc("/ccx.v1.ResumeService/ListResumeRequests", { machine: key.machine, user: key.user, sessionId: key.sessionId })
      .then((data) => {
        if (g !== gen) return;
        const r = (data.requests || []).find((x) => x.id === id);
        if (r && r.finishedAt) {
          const ok = r.outcome === "RESUME_OUTCOME_OPENED";
          return setJob(rk, ok ? "opened: " + (r.detail || "") : "failed (exit " + (r.exitCode || 0) + "): " + (r.detail || ""), false);
        }
        if (r && r.expired) {
          return setJob(
            rk,
            r.claimedAt
              ? "expired: a ccx-agent took it but did not answer, so whether it opened is not known"
              : "expired: no ccx-agent took it, so it will not be opened",
            false,
          );
        }
        if (Date.now() - started >= GIVE_UP_MS) return setJob(rk, "no answer within 300 s; check the machine", false);
        setJob(rk, r && r.claimedAt ? "taken by the ccx-agent, opening..." : "requested", true);
        setTimeout(() => poll(rk, key, id, g, started), POLL_MS);
      })
      .catch((e) => {
        if (g !== gen) return;
        if (e.status === 401) return refused();
        setJob(rk, errText(e), false);
      });
  }

  function saveToken() {
    const t = tokenIn.value.trim();
    if (!t) return;
    localStorage.setItem(TOKEN_KEY, t);
    tokenIn.value = "";
    showApp();
    load();
  }

  $("save-token").addEventListener("click", saveToken);
  tokenIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveToken();
  });
  $("refresh").addEventListener("click", () => load());
  $("forget").addEventListener("click", () => {
    localStorage.removeItem(TOKEN_KEY);
    sessions = [];
    rows.textContent = "";
    showGate("");
  });
  search.addEventListener("input", render);

  if (token()) {
    showApp();
    load();
  } else {
    showGate("");
  }
  setInterval(() => load(), REFRESH_MS);
})();
</script>
</body>
</html>
`;
