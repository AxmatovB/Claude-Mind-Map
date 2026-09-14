// Claude Brain backend.
// Reads local AI-agent session transcripts (Claude Code, Codex CLI, Gemini
// CLI, Antigravity) from disk, parses them deterministically, and serves a
// graph + stats API plus a live WebSocket feed. This process NEVER calls
// any LLM API.

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const chokidar = require('chokidar');

const claudeParser = require('./parsers/claude');
const codexParser = require('./parsers/codex');
const geminiParser = require('./parsers/gemini');
const antigravityParser = require('./parsers/antigravity');
const { buildGraph } = require('./lib/graph');
const { computeStats, computeTimeseries } = require('./lib/stats');

const PORT = process.env.PORT || 4545;
const CLAUDE_DIR = process.env.CLAUDE_DIR || '/data/claude';
const CODEX_DIR = process.env.CODEX_DIR || '/data/codex';
const GEMINI_DIR = process.env.GEMINI_DIR || '/data/gemini';
// Antigravity is a separate product from Gemini CLI (different storage
// format entirely — see parsers/antigravity.js), even though its config
// also lives under ~/.gemini on disk. Mounted from its own subpath so it
// gets its own narrow, non-credential-bearing bind mount.
const ANTIGRAVITY_DIR = process.env.ANTIGRAVITY_DIR || '/data/antigravity';
// A session counts as "live" if its transcript file was touched within this
// window. 10s (the original value) meant a session went dark the moment you
// paused to read a reply — 5 minutes tracks an actual ongoing conversation
// (thinking/typing gaps included) without stale sessions glowing forever.
const ACTIVE_WINDOW_MS = Number(process.env.ACTIVE_WINDOW_MS) || 5 * 60_000;

const AGENT_DIRS = { claude: CLAUDE_DIR, codex: CODEX_DIR, gemini: GEMINI_DIR, antigravity: ANTIGRAVITY_DIR };
const AGENT_PARSERS = { claude: claudeParser, codex: codexParser, gemini: geminiParser, antigravity: antigravityParser };

// session_file -> session object
let sessionStore = new Map();

function scanAgent(agent) {
  const dir = AGENT_DIRS[agent];
  if (!dir || !fs.existsSync(dir)) return [];
  try {
    return AGENT_PARSERS[agent].scanAll(dir);
  } catch (err) {
    console.error(`[scan] ${agent} failed:`, err.message);
    return [];
  }
}

function fullRescan() {
  const all = Object.keys(AGENT_DIRS).flatMap(scanAgent);
  sessionStore = new Map(all.map((s) => [s.session_file, s]));
  markActive();
  const counts = Object.keys(AGENT_DIRS).map((a) => `${a}=${countAgent(a)}`).join(', ');
  console.log(`[scan] loaded ${sessionStore.size} sessions (${counts})`);
}

function countAgent(agent) {
  let n = 0;
  for (const s of sessionStore.values()) if (s.agent === agent) n++;
  return n;
}

function markActive() {
  // Reads each file's real mtime from disk right now, rather than trusting
  // the cached s.mtime from the last full reparse. That cache is only
  // refreshed when chokidar's debounced 'change' event fires (gated by a
  // 400ms no-further-writes window in awaitWriteFinish) — during an actual
  // back-and-forth conversation, a transcript can be appended to more
  // often than that quiet window allows, so the cached mtime goes stale
  // and the session never gets marked live even though it plainly is. A
  // stat() per session is cheap and gives "is this live" real-time
  // accuracy independent of how backed-up the reparse pipeline is.
  const now = Date.now();
  for (const [filePath, s] of sessionStore) {
    let mtime = s.mtime;
    try {
      mtime = fs.statSync(filePath).mtimeMs;
    } catch {
      // file briefly mid-delete/rename; fall back to the cached value
    }
    s.active = now - mtime < ACTIVE_WINDOW_MS;
  }
}

function rescanOneFile(agent, filePath) {
  try {
    let parsed = null;
    if (agent === 'claude') {
      const projectFolder = path.basename(path.dirname(filePath));
      parsed = claudeParser.parseSessionFile(filePath, projectFolder);
    } else if (agent === 'codex') {
      parsed = codexParser.parseSessionFile(filePath);
    } else if (agent === 'gemini') {
      const projectFolder = path.basename(path.dirname(path.dirname(filePath)));
      const projectsMap = fs.existsSync(path.join(GEMINI_DIR, 'projects.json'))
        ? JSON.parse(fs.readFileSync(path.join(GEMINI_DIR, 'projects.json'), 'utf8')).projects || {}
        : {};
      let label = projectFolder;
      for (const [realPath, slug] of Object.entries(projectsMap)) {
        if (slug === projectFolder) { label = realPath; break; }
      }
      parsed = geminiParser.parseSessionFile(filePath, label);
    } else if (agent === 'antigravity') {
      // filePath is .../brain/<uuid>/.system_generated/logs/transcript.jsonl
      const sessionId = path.basename(path.dirname(path.dirname(path.dirname(filePath))));
      const annotationsDir = path.join(ANTIGRAVITY_DIR, 'annotations');
      parsed = antigravityParser.parseSessionFile(filePath, sessionId, annotationsDir);
    }
    if (parsed) {
      sessionStore.set(filePath, parsed);
      broadcast({ type: 'session_update', session: publicSession(parsed) });
    }
  } catch (err) {
    console.error(`[watch] failed to reparse ${filePath}:`, err.message);
  }
}

function removeFile(filePath) {
  if (sessionStore.delete(filePath)) {
    broadcast({ type: 'session_removed', session_file: filePath });
  }
}

function publicSession(s) {
  // session_file is an internal disk path; keep it out of the wire format
  // except where explicitly needed for delete-by-id lookups (we use session_id).
  const { session_file, ...rest } = s;
  return rest;
}

// ---- WebSocket live feed ----
let wss;
function broadcast(msg) {
  if (!wss) return;
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

// ---- Loopback-only access guard ----
// This app has zero authentication and exposes destructive endpoints
// (delete a session's transcript, wipe an entire agent's history) plus a
// live feed of session activity over WebSocket. Its safety model is
// entirely "only reachable from this machine" — so that has to be enforced
// explicitly, not just assumed from the Docker port mapping. Two DIFFERENT
// headers guard two DIFFERENT attacks, and neither substitutes for the
// other:
//   - Host: what address the request was sent TO. An attacker can get a
//     browser to send this as "localhost" via DNS rebinding (resolving an
//     attacker-controlled domain to 127.0.0.1 mid-session) while the page
//     itself is still on a different origin — checking Host catches that.
//   - Origin: what page/site INITIATED the request. A page on any other
//     site can, without any DNS trickery, directly open
//     ws://localhost:4545/ws — the browser will send a perfectly correct
//     Host header (that genuinely is where it's connecting) but an Origin
//     of that other site. This is cross-site WebSocket hijacking (CSWSH):
//     WebSocket connections aren't subject to the same-origin policy the
//     way fetch()/XHR are, so only an explicit Origin check on the server
//     blocks it — Host alone does not, since Host is correct in this attack.
// Both checks below only reject when the header is PRESENT and mismatched;
// a missing Origin (e.g. curl, or a non-browser WebSocket client) is
// allowed, since the browser is the only client that can't spoof Origin —
// that's also what keeps the curl examples in the README working.
function isLoopbackHost(hostHeader) {
  if (!hostHeader) return false;
  const host = hostHeader.split(':')[0].toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function isAllowedOrigin(originHeader) {
  if (!originHeader) return true; // non-browser clients don't send Origin
  try {
    const { hostname } = new URL(originHeader);
    const host = hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

// ---- Express app ----
const app = express();
app.use((req, res, next) => {
  if (!isLoopbackHost(req.headers.host) || !isAllowedOrigin(req.headers.origin)) {
    return res.status(403).json({ error: 'forbidden: this app only accepts loopback requests' });
  }
  next();
});
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    agents: {
      claude: fs.existsSync(CLAUDE_DIR),
      codex: fs.existsSync(CODEX_DIR),
      gemini: fs.existsSync(GEMINI_DIR),
      antigravity: fs.existsSync(ANTIGRAVITY_DIR),
    },
  });
});

app.get('/api/sessions', (req, res) => {
  markActive();
  const list = [...sessionStore.values()]
    .map(publicSession)
    .sort((a, b) => new Date(b.start_time) - new Date(a.start_time));
  res.json(list);
});

app.get('/api/sessions/:id', (req, res) => {
  const s = [...sessionStore.values()].find((x) => x.session_id === req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json(publicSession(s));
});

app.get('/api/graph', (req, res) => {
  markActive();
  res.json(buildGraph([...sessionStore.values()]));
});

app.get('/api/stats', (req, res) => {
  res.json(computeStats([...sessionStore.values()]));
});

app.get('/api/timeseries', (req, res) => {
  const { granularity, from, to } = req.query;
  res.json(computeTimeseries([...sessionStore.values()], { granularity, from, to }));
});

// Delete a single session's transcript file. Irreversible; requires ?confirm=true.
app.delete('/api/sessions/:id', (req, res) => {
  if (req.query.confirm !== 'true') {
    return res.status(400).json({ error: 'must pass ?confirm=true' });
  }
  const entry = [...sessionStore.entries()].find(([, s]) => s.session_id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'not found' });
  const [filePath] = entry;
  try {
    fs.unlinkSync(filePath);
    removeFile(filePath);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk delete.
app.post('/api/sessions/delete-bulk', (req, res) => {
  if (req.body?.confirm !== true) {
    return res.status(400).json({ error: 'must pass { confirm: true }' });
  }
  const ids = new Set(req.body?.session_ids || []);
  const deleted = [];
  const failed = [];
  for (const [filePath, s] of [...sessionStore.entries()]) {
    if (!ids.has(s.session_id)) continue;
    try {
      fs.unlinkSync(filePath);
      removeFile(filePath);
      deleted.push(s.session_id);
    } catch (err) {
      failed.push({ session_id: s.session_id, error: err.message });
    }
  }
  res.json({ deleted, failed });
});

// Wipe an entire agent's history from disk. Two-step confirmation: the
// frontend must send confirm_name === agent name in uppercase.
app.post('/api/agents/:agent/clear', (req, res) => {
  const agent = req.params.agent;
  if (!AGENT_DIRS[agent]) return res.status(400).json({ error: 'unknown agent' });
  const expected = agent.toUpperCase();
  if (req.body?.confirm_name !== expected) {
    return res.status(400).json({ error: `must pass { confirm_name: "${expected}" }` });
  }
  const files = [...sessionStore.entries()].filter(([, s]) => s.agent === agent);
  const deleted = [];
  const failed = [];
  for (const [filePath, s] of files) {
    try {
      fs.unlinkSync(filePath);
      removeFile(filePath);
      deleted.push(s.session_id);
    } catch (err) {
      failed.push({ session_id: s.session_id, error: err.message });
    }
  }
  res.json({ agent, deleted_count: deleted.length, failed });
});

// Chart.js and vis-network are bundled as npm deps and served from our own
// process instead of a CDN — some networks (corporate proxies, ad-blockers,
// flaky CDN edges) block or fail third-party script domains, and this is a
// fully-local tool anyway, so there's no reason to depend on the internet
// for its own UI libraries.
app.use('/vendor/chart.js', express.static(path.join(__dirname, 'node_modules', 'chart.js', 'dist')));
app.use('/vendor/vis-network', express.static(path.join(__dirname, 'node_modules', 'vis-network', 'standalone', 'umd')));

app.use(express.static(path.join(__dirname, '..', 'frontend', 'public')));

// ---- File watching ----
function setupWatchers() {
  for (const [agent, dir] of Object.entries(AGENT_DIRS)) {
    if (!fs.existsSync(dir)) {
      console.log(`[watch] skipping ${agent}: ${dir} not mounted`);
      continue;
    }
    const watchDir = agent === 'codex' ? path.join(dir, 'sessions')
      : agent === 'gemini' ? path.join(dir, 'tmp')
        : agent === 'antigravity' ? path.join(dir, 'brain')
          : path.join(dir, 'projects');
    if (!fs.existsSync(watchDir)) continue;

    // Only ever watch the session-transcript subtree, never the whole
    // ~/.claude, ~/.codex, ~/.gemini home dirs (those contain large
    // unrelated trees like shell-snapshots and credentials, and recursively
    // watching them is both wasteful and slow over a Docker bind mount).
    const watcher = chokidar.watch(watchDir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
      depth: 6,
    });

    // Antigravity's session folders also contain transcript_full.jsonl and
    // chunked copies under chunks/ — only the top-level transcript.jsonl is
    // what parseSessionFile expects (its path layout assumption depends on
    // it), so those other .jsonl files must be filtered out here.
    const isRelevant = agent === 'antigravity'
      ? (p) => path.basename(p) === 'transcript.jsonl' && path.basename(path.dirname(p)) === 'logs'
      : (p) => p.endsWith('.jsonl');

    watcher.on('add', (p) => { if (isRelevant(p)) rescanOneFile(agent, p); });
    watcher.on('change', (p) => {
      if (!isRelevant(p)) return;
      rescanOneFile(agent, p);
      broadcast({
        type: 'activity',
        agent,
        session_file: p,
        at: Date.now(),
      });
    });
    watcher.on('unlink', (p) => { if (isRelevant(p)) removeFile(p); });

    console.log(`[watch] watching ${agent}: ${watchDir}`);
  }
}

// Periodically flip active/idle status even with no new file events.
setInterval(() => {
  markActive();
}, 3000);

fullRescan();
setupWatchers();

const server = http.createServer(app);
// WebSocket upgrades bypass the Express middleware chain entirely (they're
// handled via the http.Server's 'upgrade' event, not Express's 'request'
// event), so the guard above doesn't cover this — it needs its own check
// here, and needs BOTH the Host and Origin checks (see the comment on
// isLoopbackHost/isAllowedOrigin above): Host alone stops DNS rebinding but
// not a page on any other site directly opening ws://localhost:PORT/ws
// (cross-site WebSocket hijacking) — only the Origin check stops that.
// Without both, any page you have open could receive every
// session_update/activity broadcast (project paths, session ids, tool
// usage) this feed carries.
wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: (info) => isLoopbackHost(info.req.headers.host) && isAllowedOrigin(info.origin),
});
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', sessions: sessionStore.size }));
});

server.listen(PORT, () => {
  console.log(`Claude Brain listening on http://localhost:${PORT}`);
});
