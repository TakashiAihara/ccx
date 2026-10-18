// 止まった session を選んで元のマシンで開き直す人向けのページ (#261)。HTML 1 枚に
// style と script を入れる。script は UI_SCRIPT の 1 つだけで、server.ts がその hash を CSP に載せる。
// token は人が入力欄に入れ、この page には埋め込まない。
export const UI_SCRIPT = String.raw`(() => {
  "use strict";
  const TOKEN_KEY = "ccx-center-token";
  const WAIT_SECONDS = 40;
  const LIST_LIMIT = 500;
  const RECENT_LIMIT = 50;
  const PENDING_MS = 2000;
  const REFRESH_MS = 30000;

  const $ = (id) => document.getElementById(id);
  const gate = $("gate");
  const app = $("app");
  const tokenIn = $("token-in");
  const gateMsg = $("gate-msg");
  const search = $("search");
  const listMsg = $("list-msg");
  const reqMsg = $("req-msg");
  const rows = $("rows");
  const recent = $("recent");

  // one row object per stopped session, kept across reloads so a click or focus survives a redraw
  const rowsByKey = new Map();
  // a failed RequestResume shows on its row until that row's next RequestResume succeeds
  const rowErr = new Map();
  const busy = new Set();
  let sessions = [];
  let requests = [];

  // gen moves when the token changes or the gate comes back; a response from an older gen writes nothing
  let gen = 0;
  // at most one list read and one request read per gen
  let listGen = -1;
  let reqGen = -1;
  let reqAgain = false;
  let reqTimer = 0;

  const token = () => localStorage.getItem(TOKEN_KEY) || "";
  const visible = () => !app.hidden && document.visibilityState === "visible";

  function rpc(path, body) {
    const t = token();
    return fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) },
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
    e.status ? "error: " + e.status + " " + e.text.slice(0, 200) : "error: " + e.text;

  const ago = (iso) => {
    const t = Date.parse((iso || "").replace(/\.\d+Z$/, "Z"));
    if (Number.isNaN(t)) return "-";
    const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (sec < 60) return sec + "s";
    if (sec < 3600) return Math.floor(sec / 60) + "m";
    if (sec < 86400) return Math.floor(sec / 3600) + "h";
    return Math.floor(sec / 86400) + "d";
  };

  const rowKey = (k) => JSON.stringify([k.machine, k.user, k.sessionId]);

  // the text for one request, and whether Open may be pressed for its session
  function statusOf(r) {
    if (r.finishedAt) {
      const detail = r.detail || "";
      if (r.outcome === "RESUME_OUTCOME_OPENED") return { text: "opened: " + detail, open: true };
      if (r.outcome === "RESUME_OUTCOME_FAILED") {
        const code = r.exitCode === undefined ? "?" : r.exitCode;
        return { text: "failed (exit " + code + "): " + detail, open: true };
      }
      return { text: "finished, outcome unknown: " + detail, open: true };
    }
    if (r.expired) {
      const text = r.claimedAt
        ? "expired: a ccx-agent took it but did not answer, so whether it opened is not known"
        : "expired: no ccx-agent took it, so it will not be opened";
      return { text, open: true };
    }
    if (r.claimedAt) return { text: "taken by the ccx-agent, opening...", open: false };
    return { text: "requested, waiting for the ccx-agent on " + r.key.machine, open: false };
  }

  function td(text, cls) {
    const e = document.createElement("td");
    e.textContent = text;
    if (cls) e.className = cls;
    return e;
  }

  function showGate(msg) {
    newGen();
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

  // 401 with a saved token: the center refused it. 401 without one: the center wants a token
  function unauthorized() {
    const msg = token() ? "the center refused the token" : "the center asks for a token";
    localStorage.removeItem(TOKEN_KEY);
    showGate(msg);
  }

  function newGen() {
    gen++;
    reqAgain = false;
    clearTimeout(reqTimer);
    rowsByKey.clear();
    rowErr.clear();
    busy.clear();
    rows.textContent = "";
    sessions = [];
    requests = [];
    render();
  }

  function makeRow(rk) {
    const row = { s: null, tr: document.createElement("tr") };
    row.btn = document.createElement("button");
    row.btn.type = "button";
    row.btn.textContent = "Open";
    row.btn.addEventListener("click", () => openSession(row.s));
    row.note = document.createElement("div");
    row.note.className = "state";
    const open = document.createElement("td");
    open.append(row.btn, row.note);
    row.label = td("", "wrap");
    row.task = td("", "wrap");
    row.cwd = td("", "wrap");
    row.machine = td("");
    row.user = td("");
    row.seen = td("");
    row.sid = td("");
    row.tr.append(open, row.label, row.task, row.cwd, row.machine, row.user, row.seen, row.sid);
    rowsByKey.set(rk, row);
    return row;
  }

  function fill(row, rk, s, q) {
    const st = s.state || {};
    const latest = requests.find((r) => rowKey(r.key) === rk);
    const status = latest ? statusOf(latest) : { text: "", open: true };
    const err = rowErr.get(rk) || "";
    row.s = s;
    row.note.textContent = err || status.text;
    row.note.hidden = !(err || status.text);
    row.btn.disabled = busy.has(rk) || !status.open;
    row.label.textContent = st.label || "-";
    row.task.textContent = st.task || "";
    row.cwd.textContent = s.cwd || "";
    row.machine.textContent = s.key.machine;
    row.user.textContent = s.key.user;
    row.seen.textContent = ago(s.lastSeen);
    row.sid.textContent = s.key.sessionId.slice(0, 8);
    row.sid.title = s.key.sessionId;
    const hay = [st.label, st.task, s.cwd, s.key.machine, s.key.user, s.key.sessionId];
    row.tr.hidden = q !== "" && !hay.some((v) => (v || "").toLowerCase().includes(q));
  }

  // rows are reused by key, so a reload changes text and disabled state only; a row moves only when
  // the server's order changed
  function renderRows() {
    const q = search.value.trim().toLowerCase();
    const keys = new Set(sessions.map((s) => rowKey(s.key)));
    for (const [rk, row] of rowsByKey) {
      if (!keys.has(rk)) {
        row.tr.remove();
        rowsByKey.delete(rk);
      }
    }
    sessions.forEach((s, i) => {
      const rk = rowKey(s.key);
      const row = rowsByKey.get(rk) || makeRow(rk);
      fill(row, rk, s, q);
      if (rows.children[i] !== row.tr) rows.insertBefore(row.tr, rows.children[i] || null);
    });
  }

  function renderRecent() {
    recent.textContent = "";
    if (!requests.length) {
      const none = td("no requests yet");
      none.colSpan = 6;
      const tr = document.createElement("tr");
      tr.append(none);
      recent.append(tr);
      return;
    }
    for (const r of requests) {
      const rk = rowKey(r.key);
      const listed = sessions.find((s) => rowKey(s.key) === rk);
      const label = listed && listed.state && listed.state.label ? listed.state.label : "-";
      const sid = td(r.key.sessionId.slice(0, 8));
      sid.title = r.key.sessionId;
      const tr = document.createElement("tr");
      tr.append(
        td(statusOf(r).text, "wrap"),
        td(label, "wrap"),
        td(r.key.machine),
        td(r.key.user),
        sid,
        td(ago(r.requestedAt)),
      );
      recent.append(tr);
    }
  }

  function render() {
    renderRows();
    renderRecent();
  }

  async function load() {
    if (app.hidden || listGen === gen) return;
    const g = gen;
    listGen = g;
    // the first list takes seconds on a large center; an empty table alone reads as broken
    if (!sessions.length) {
      listMsg.className = "msg";
      listMsg.textContent = "loading...";
    }
    try {
      const data = await rpc("/ccx.v1.FleetService/ListSessions", { stoppedOnly: true, limit: LIST_LIMIT });
      if (g !== gen) return;
      sessions = data.sessions || [];
      listMsg.className = "msg";
      if (sessions.length === LIST_LIMIT) {
        listMsg.textContent =
          "showing the newest " + LIST_LIMIT + "; narrow it with the filter or ccx session ls --stopped (the filter only searches these)";
      } else {
        listMsg.textContent = sessions.length ? "" : "no stopped sessions";
      }
      render();
    } catch (e) {
      if (g !== gen) return;
      if (e.status === 401) return unauthorized();
      listMsg.className = "msg err";
      listMsg.textContent = errText(e);
    } finally {
      if (listGen === g) listGen = -1;
    }
  }

  function scheduleRequests() {
    clearTimeout(reqTimer);
    if (!visible()) return;
    const pending = requests.some((r) => !r.finishedAt && !r.expired);
    reqTimer = setTimeout(() => {
      if (visible()) loadRequests();
    }, pending ? PENDING_MS : REFRESH_MS);
  }

  async function loadRequests() {
    if (app.hidden) return;
    if (reqGen === gen) {
      reqAgain = true;
      return;
    }
    const g = gen;
    reqGen = g;
    try {
      const data = await rpc("/ccx.v1.ResumeService/ListResumeRequests", { limit: RECENT_LIMIT });
      if (g !== gen) return;
      requests = data.requests || [];
      reqMsg.textContent = "";
      render();
    } catch (e) {
      if (g !== gen) return;
      if (e.status === 401) return unauthorized();
      reqMsg.textContent = errText(e);
    } finally {
      if (reqGen === g) reqGen = -1;
      if (g === gen) {
        if (reqAgain) {
          reqAgain = false;
          loadRequests();
        } else {
          scheduleRequests();
        }
      }
    }
  }

  async function openSession(s) {
    const rk = rowKey(s.key);
    const g = gen;
    busy.add(rk);
    rowErr.delete(rk);
    render();
    try {
      await rpc("/ccx.v1.ResumeService/RequestResume", { key: s.key, waitSeconds: WAIT_SECONDS });
      if (g !== gen) return;
      loadRequests();
    } catch (e) {
      if (g !== gen) return;
      if (e.status === 401) return unauthorized();
      rowErr.set(rk, errText(e));
    } finally {
      if (g === gen) {
        busy.delete(rk);
        render();
      }
    }
  }

  function saveToken() {
    const t = tokenIn.value.trim();
    if (!t) return;
    newGen();
    localStorage.setItem(TOKEN_KEY, t);
    tokenIn.value = "";
    showApp();
    load();
    loadRequests();
  }

  $("save-token").addEventListener("click", saveToken);
  tokenIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveToken();
  });
  $("refresh").addEventListener("click", () => {
    load();
    loadRequests();
  });
  $("forget").addEventListener("click", () => {
    localStorage.removeItem(TOKEN_KEY);
    showGate("");
  });
  search.addEventListener("input", renderRows);
  document.addEventListener("visibilitychange", () => {
    if (visible()) {
      load();
      loadRequests();
    }
  });
  setInterval(() => {
    if (visible()) load();
  }, REFRESH_MS);

  // without a saved token the first list goes out with no Authorization; the gate appears only on 401
  showApp();
  load();
  loadRequests();
})();`;

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
h2 { font-size: 15px; margin: 18px 0 6px; }
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

  <h2>Recent requests</h2>
  <p id="req-msg" class="msg err"></p>
  <div class="scroll">
    <table>
      <thead>
        <tr>
          <th>status</th>
          <th>label</th>
          <th>machine</th>
          <th>user</th>
          <th>session</th>
          <th>requested</th>
        </tr>
      </thead>
      <tbody id="recent"></tbody>
    </table>
  </div>

  <h2>Stopped sessions</h2>
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

<script>${UI_SCRIPT}</script>
</body>
</html>
`;
