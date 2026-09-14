// Claude Brain frontend. No LLM calls — pure fetch/render against the local
// backend API and WebSocket feed.

const AGENT_COLORS = {
  claude: '#ffb300',
  codex: '#00fff2',
  gemini: '#ff2fd0',
};

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const state = {
  sessions: [],
  graph: { nodes: [], edges: [] },
  stats: null,
  activeAgents: new Set(['claude', 'codex', 'gemini']),
  selectedSessionIds: new Set(),
  network: null,
  nodesDS: null,
  edgesDS: null,
  selectedNodeId: null,
  blinkOn: false,
  period: 'day',
  customFrom: null,
  customTo: null,
  chart: null,
};

const LAST_TAB_KEY = 'claudeBrain.activeTab';

// ---------- tabs ----------
// The active tab is persisted to localStorage so a page reload lands back
// on whatever section (Mind Map / Stats / Sessions) you were looking at.
function activateTab(tabName, { persist = true } = {}) {
  const btn = document.querySelector(`.tab[data-tab="${tabName}"]`);
  if (!btn) return;
  document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById(`view-${tabName}`).classList.add('active');
  if (persist) {
    try { localStorage.setItem(LAST_TAB_KEY, tabName); } catch { /* private mode, etc. */ }
  }
  if (tabName === 'graph') renderGraph();
  if (tabName === 'stats') { renderStats(); loadTimeseries(); }
  if (tabName === 'sessions') renderSessionsTable();
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => activateTab(btn.dataset.tab));
});

// ---------- data loading ----------
async function loadAll() {
  const [sessions, graph, stats] = await Promise.all([
    fetch('/api/sessions').then((r) => r.json()),
    fetch('/api/graph').then((r) => r.json()),
    fetch('/api/stats').then((r) => r.json()),
  ]);
  state.sessions = sessions;
  state.graph = graph;
  state.stats = stats;
  renderAgentChips();
  renderGraph();
  renderStats();
  renderSessionsTable();
  if (document.getElementById('view-stats').classList.contains('active')) loadTimeseries();
}

// ---------- agent chips ----------
function renderAgentChips() {
  const counts = {};
  for (const s of state.sessions) counts[s.agent] = (counts[s.agent] || 0) + 1;
  const present = Object.keys(counts);
  const wrap = document.getElementById('agentChips');
  wrap.innerHTML = '';
  const select = document.getElementById('agentFilterSelect');
  const prevVal = select.value;
  select.innerHTML = '<option value="">all agents</option>';

  for (const agent of present) {
    const chip = document.createElement('div');
    chip.className = `chip ${agent}` + (state.activeAgents.has(agent) ? '' : ' off');
    chip.innerHTML = `<span>${agent}</span><span class="badge">${counts[agent]}</span>`;
    chip.addEventListener('click', () => {
      if (state.activeAgents.has(agent)) state.activeAgents.delete(agent);
      else state.activeAgents.add(agent);
      renderAgentChips();
      renderGraph();
      renderSessionsTable();
    });
    wrap.appendChild(chip);

    const opt = document.createElement('option');
    opt.value = agent;
    opt.textContent = agent;
    select.appendChild(opt);
  }
  select.value = prevVal;

  renderDangerZone(present);
}

function renderDangerZone(present) {
  const zone = document.getElementById('dangerZone');
  zone.innerHTML = '';
  for (const agent of present) {
    const btn = document.createElement('button');
    btn.className = 'danger';
    btn.textContent = `Wipe ${agent}`;
    btn.addEventListener('click', () => openWipeModal(agent));
    zone.appendChild(btn);
  }
}

// ---------- mind map ----------
// The network is created once and updated in place on every refresh (DataSet
// diff, not destroy/recreate) so zoom/pan/positions survive live updates —
// this is what previously caused the "flicker" and "resets when I try to
// zoom" symptoms. Physics settles once, then turns off so nodes stop
// drifting into each other; it's only re-enabled briefly when the node set
// actually changes shape (so new nodes get placed sensibly).
const NODE_KEY_FIELDS = ['label', 'type', 'active'];

function visibleNodesAndEdges() {
  const filteredNodeIds = new Set();
  const nodes = state.graph.nodes.filter((n) => {
    if (n.type === 'hub') return true;
    if (n.agent && !state.activeAgents.has(n.agent)) return false;
    return true;
  });
  nodes.forEach((n) => filteredNodeIds.add(n.id));

  const edges = state.graph.edges.filter(
    (e) => filteredNodeIds.has(e.source) && filteredNodeIds.has(e.target)
  );
  return { nodes, edges };
}

function toVisEdge(e) {
  return {
    id: `${e.source}=>${e.target}`,
    from: e.source,
    to: e.target,
    color: { color: 'rgba(0,255,242,0.2)', highlight: '#00fff2' },
    width: Math.min(1 + (e.weight || 1) * 0.3, 4),
    smooth: { type: 'continuous', roundness: 0.35 },
  };
}

function renderGraph() {
  const container = document.getElementById('graphContainer');
  const { nodes, edges } = visibleNodesAndEdges();
  const visNodes = nodes.map((n) => styleNode(n));
  const visEdges = edges.map(toVisEdge);
  updateSizeHud(nodes);

  if (!state.network) {
    initGraph(container, visNodes, visEdges);
    return;
  }
  diffUpdateGraph(visNodes, visEdges);
}

function updateSizeHud(visibleNodes) {
  const total = visibleNodes
    .filter((n) => n.type === 'session')
    .reduce((sum, n) => sum + (n.size_bytes || 0), 0);
  document.getElementById('sizeHudValue').textContent = formatBytes(total);
}

function initGraph(container, visNodes, visEdges) {
  state.nodesDS = new vis.DataSet(visNodes);
  state.edgesDS = new vis.DataSet(visEdges);

  const options = {
    autoResize: true,
    // Physics stays on permanently but tuned very soft (low spring/gravity
    // constants, heavy damping) so the map keeps a slow, alive "breathing"
    // drift instead of sitting dead-still — without the harsh jitter and
    // node-collision glitching the strong version had. avoidOverlap keeps
    // nodes from ever touching, which was the actual source of the old
    // "shaking" (nodes physically colliding and bouncing off each other).
    physics: {
      solver: 'forceAtlas2Based',
      forceAtlas2Based: {
        gravitationalConstant: -35,
        springLength: 180,
        springConstant: 0.012,
        avoidOverlap: 1,
        damping: 0.75,
      },
      stabilization: { iterations: 300, fit: true },
      minVelocity: 0.15,
      maxVelocity: 8,
      timestep: 0.4,
    },
    interaction: { hover: true, tooltipDelay: 100, zoomView: true, dragView: true },
    nodes: { shape: 'dot', font: { color: '#d8fdf5', face: 'Share Tech Mono', size: 11 }, scaling: { min: 6, max: 40 } },
    edges: { arrows: { to: false } },
    layout: { improvedLayout: true },
  };

  state.network = new vis.Network(container, { nodes: state.nodesDS, edges: state.edgesDS }, options);

  state.network.on('click', (params) => {
    if (params.nodes.length) {
      showNodeDetail(params.nodes[0]);
    } else {
      hideDetail();
    }
  });

  startBlinkLoop();
}

function diffUpdateGraph(visNodes, visEdges) {
  const newNodeIds = new Set(visNodes.map((n) => n.id));
  const oldNodeIds = new Set(state.nodesDS.getIds());
  const newEdgeIds = new Set(visEdges.map((e) => e.id));
  const oldEdgeIds = new Set(state.edgesDS.getIds());

  const removedNodes = [...oldNodeIds].filter((id) => !newNodeIds.has(id));
  const removedEdges = [...oldEdgeIds].filter((id) => !newEdgeIds.has(id));

  // Only push updates for nodes whose meaningful fields actually changed —
  // color is excluded here because the blink loop owns it continuously for
  // active nodes; diffing it would fight the blink loop every refresh.
  const changedNodes = visNodes.filter((n) => {
    const existing = state.nodesDS.get(n.id);
    if (!existing) return true;
    return NODE_KEY_FIELDS.some((f) => JSON.stringify(existing[f]) !== JSON.stringify(n[f]));
  });

  if (removedNodes.length) state.nodesDS.remove(removedNodes);
  if (removedEdges.length) state.edgesDS.remove(removedEdges);
  if (changedNodes.length) state.nodesDS.update(changedNodes);
  state.edgesDS.update(visEdges.filter((e) => !oldEdgeIds.has(e.id)));
  // Physics runs continuously (see initGraph), so newly added nodes settle
  // into place on their own without any special-casing here.
}

// Active (live-right-now) session nodes glow white with a slow sine-wave
// pulse — a session you're actually using should be unmistakable, and a
// smooth breathing fade reads as "alive" better than a hard on/off blink.
const PULSE_PERIOD_MS = 2600;

function lerp(a, b, t) { return a + (b - a) * t; }
function lerpColor(c1, c2, t) {
  const p = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [r1, g1, b1] = p(c1);
  const [r2, g2, b2] = p(c2);
  const r = Math.round(lerp(r1, r2, t)).toString(16).padStart(2, '0');
  const g = Math.round(lerp(g1, g2, t)).toString(16).padStart(2, '0');
  const b = Math.round(lerp(b1, b2, t)).toString(16).padStart(2, '0');
  return `#${r}${g}${b}`;
}

function startBlinkLoop() {
  const t0 = performance.now();
  setInterval(() => {
    if (!state.nodesDS) return;
    const phase = (Math.sin(((performance.now() - t0) / PULSE_PERIOD_MS) * Math.PI * 2) + 1) / 2; // 0..1
    const bg = lerpColor('#3a4a48', '#ffffff', phase);
    const glowSize = lerp(8, 30, phase);
    const updates = [];
    for (const n of state.nodesDS.get()) {
      if (!n.active) continue;
      updates.push({
        id: n.id,
        color: { background: bg, border: '#ffffff' },
        shadow: { enabled: true, color: '#ffffff', size: glowSize },
      });
    }
    if (updates.length) state.nodesDS.update(updates);
  }, 120);
}

function styleNode(n) {
  // `type` and `active` ride along on every vis node object (not just used
  // for the switch below) — the click handler and the blink loop both need
  // to read them back off the DataSet later.
  const base = { id: n.id, label: n.label, type: n.type, active: !!n.active };
  switch (n.type) {
    case 'hub':
      return { ...base, size: 34, color: { background: '#0a0a0f', border: '#39ff88' },
        font: { color: '#39ff88', size: 16 }, shadow: { enabled: true, color: '#39ff88', size: 20 } };
    case 'agent': {
      const c = AGENT_COLORS[n.agent] || '#888';
      return { ...base, size: 24, color: { background: '#0a0a0f', border: c },
        font: { color: c, size: 13 }, shadow: { enabled: true, color: c, size: 14 } };
    }
    case 'project': {
      const c = AGENT_COLORS[n.agent] || '#888';
      return { ...base, size: 16, color: { background: 'rgba(0,0,0,0.4)', border: c },
        font: { color: c, size: 10 } };
    }
    case 'session': {
      const c = AGENT_COLORS[n.agent] || '#888';
      const style = { ...base, size: 10, shape: 'dot',
        color: { background: c, border: c },
        font: { color: c, size: 9 } };
      // Active nodes get their glow/color driven by startBlinkLoop() on an
      // interval, not fixed here — this is just the resting (non-live) look.
      return style;
    }
    case 'tool':
      return { ...base, size: 8, shape: 'square', color: { background: '#1a1c24', border: '#6b7a86' },
        font: { color: '#6b7a86', size: 9 } };
    case 'topic':
      return { ...base, size: 7, shape: 'diamond', color: { background: '#1a1c24', border: '#ff2fd0' },
        font: { color: '#ff2fd0', size: 9 } };
    default:
      return base;
  }
}

// Dispatches to a type-specific renderer so clicking ANY node (hub, agent,
// project, tool, topic — not just a session) opens something on the right.
function showNodeDetail(nodeId) {
  const node = state.graph.nodes.find((n) => n.id === nodeId);
  if (!node) return hideDetail();
  state.selectedNodeId = nodeId;
  switch (node.type) {
    case 'session': return showSessionDetail(node.session_id);
    case 'hub': return showHubDetail();
    case 'agent': return showAgentDetail(node.agent);
    case 'project': return showProjectDetail(node);
    case 'tool': return showToolOrTopicDetail(node, 'tool');
    case 'topic': return showToolOrTopicDetail(node, 'topic');
    default: return hideDetail();
  }
}

function sessionsConnectedTo(nodeId) {
  const sessionIds = new Set();
  for (const e of state.graph.edges) {
    if (e.source === nodeId) sessionIds.add(e.target);
    else if (e.target === nodeId) sessionIds.add(e.source);
  }
  return state.graph.nodes
    .filter((n) => n.type === 'session' && sessionIds.has(n.id))
    .sort((a, b) => new Date(b.start_time) - new Date(a.start_time));
}

function openPanel(html) {
  document.getElementById('detailContent').innerHTML = html;
  document.getElementById('detailPanel').classList.remove('hidden');
}

function sessionListHtml(sessionNodes, limit = 12) {
  if (!sessionNodes.length) return '<i>none</i>';
  const rows = sessionNodes.slice(0, limit).map((n) => `
    <div class="kv" style="cursor:pointer" data-goto-session="${esc(n.session_id)}">
      <b>${esc(n.label)}</b><span>${new Date(n.start_time).toLocaleDateString()}</span>
    </div>`).join('');
  const more = sessionNodes.length > limit ? `<p style="color:#6b7a86;">+${sessionNodes.length - limit} more</p>` : '';
  return rows + more;
}

function wireSessionListClicks() {
  document.querySelectorAll('[data-goto-session]').forEach((el) => {
    el.addEventListener('click', () => showSessionDetail(el.dataset.gotoSession));
  });
}

function showHubDetail() {
  const st = state.stats;
  openPanel(`
    <h3>CLAUDE_BRAIN</h3>
    <div class="kv"><b>total sessions</b><span>${st?.total_sessions ?? state.sessions.length}</span></div>
    <div class="kv"><b>agents tracked</b><span>${[...new Set(state.sessions.map((s) => s.agent))].length}</span></div>
    <div class="kv"><b>active days</b><span>${st?.active_days ?? '—'}</span></div>
    <p style="color:#6b7a86;margin-top:10px;">Click an agent, project, session, tool, or topic node for details.</p>
  `);
}

function showAgentDetail(agent) {
  const agg = state.stats?.by_agent?.[agent];
  const sessionNodes = sessionsConnectedTo(`agent:${agent}`);
  const projects = [...new Set(sessionNodes.map((n) => n.project))];
  const projectRows = projects.length
    ? projects.map((p) => `<span class="tag">${esc(shorten(p))}</span>`).join('')
    : '<i>none</i>';
  openPanel(`
    <h3>${esc(agent)}</h3>
    <div class="kv"><b>sessions</b><span>${agg?.sessions ?? 0}</span></div>
    <div class="kv"><b>tokens in</b><span>${(agg?.tokens.input ?? 0).toLocaleString()}</span></div>
    <div class="kv"><b>tokens out</b><span>${(agg?.tokens.output ?? 0).toLocaleString()}</span></div>
    <p style="color:#6b7a86;margin-top:10px;">projects</p>${projectRows}
  `);
}

function showProjectDetail(node) {
  const sessionNodes = sessionsConnectedTo(node.id);
  openPanel(`
    <h3 title="${esc(node.label)}">${esc(node.label)}</h3>
    <div class="kv"><b>agent</b><span>${esc(node.agent)}</span></div>
    <div class="kv"><b>sessions</b><span>${sessionNodes.length}</span></div>
    <p style="color:#6b7a86;margin-top:10px;">sessions</p>
    ${sessionListHtml(sessionNodes)}
  `);
  wireSessionListClicks();
}

function showToolOrTopicDetail(node, kind) {
  const sessionNodes = sessionsConnectedTo(node.id);
  openPanel(`
    <h3>${esc(node.label)}</h3>
    <div class="kv"><b>type</b><span>${kind}</span></div>
    <div class="kv"><b>used in</b><span>${sessionNodes.length} session(s)</span></div>
    <p style="color:#6b7a86;margin-top:10px;">sessions</p>
    ${sessionListHtml(sessionNodes)}
  `);
  wireSessionListClicks();
}

async function showSessionDetail(sessionId) {
  const res = await fetch(`/api/sessions/${sessionId}`);
  if (!res.ok) return;
  const s = await res.json();
  const panel = document.getElementById('detailPanel');
  const c = document.getElementById('detailContent');
  const tools = Object.entries(s.tools_used || {}).map(([t, n]) => `<span class="tag">${esc(t)} ×${n}</span>`).join('');
  const kws = (s.keywords || []).map((k) => `<span class="tag">${esc(k.word)}</span>`).join('');
  c.innerHTML = `
    <h3>${esc(s.session_id)}</h3>
    <div class="kv"><b>agent</b><span>${esc(s.agent)}</span></div>
    <div class="kv"><b>project</b><span title="${esc(s.project)}">${esc(shorten(s.project))}</span></div>
    <div class="kv"><b>start</b><span>${new Date(s.start_time).toLocaleString()}</span></div>
    <div class="kv"><b>end</b><span>${new Date(s.end_time).toLocaleString()}</span></div>
    <div class="kv"><b>messages</b><span>${s.message_count}</span></div>
    <div class="kv"><b>tokens in</b><span>${s.tokens.input.toLocaleString()}</span></div>
    <div class="kv"><b>tokens out</b><span>${s.tokens.output.toLocaleString()}</span></div>
    <div class="kv"><b>cache</b><span>${s.tokens.cache.toLocaleString()}</span></div>
    ${s.model ? `<div class="kv"><b>model</b><span>${esc(s.model)}</span></div>` : ''}
    <p style="color:#6b7a86;margin-top:10px;">tools</p>${tools || '<i>none</i>'}
    <p style="color:#6b7a86;margin-top:10px;">topics</p>${kws || '<i>none</i>'}
  `;
  panel.classList.remove('hidden');
}
document.getElementById('closeDetail').addEventListener('click', hideDetail);
function hideDetail() { document.getElementById('detailPanel').classList.add('hidden'); }

function shorten(p) {
  if (!p) return '';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/');
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// ---------- stats ----------
function renderStats() {
  if (!state.stats) return;
  const st = state.stats;
  const cards = [
    ['Total sessions', st.total_sessions],
    ['Input tokens', st.total_tokens.input.toLocaleString()],
    ['Output tokens', st.total_tokens.output.toLocaleString()],
    ['Cache tokens', st.total_tokens.cache.toLocaleString()],
    ['Favorite model', st.favorite_model || '—'],
    ['Longest session', st.longest_session ? formatDuration(st.longest_session.durationMs) : '—'],
    ['Active days', st.active_days],
    ['Current streak', `${st.current_streak}d`],
    ['Longest streak', `${st.longest_streak}d`],
  ];
  document.getElementById('statCards').innerHTML = cards.map(([label, value]) => `
    <div class="card"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div></div>
  `).join('');

  renderHeatmap(st.heatmap);
}

function formatDuration(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = (mins / 60).toFixed(1);
  return `${hrs}h`;
}

function renderHeatmap(entries) {
  const map = new Map(entries.map((e) => [e.day, e]));
  const el = document.getElementById('heatmap');
  el.innerHTML = '';
  const today = new Date();
  const days = [];
  for (let i = 364; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  for (const day of days) {
    const entry = map.get(day);
    const level = entry ? Math.min(4, Math.ceil(entry.sessions)) : 0;
    const cell = document.createElement('div');
    cell.className = 'hm-cell';
    cell.dataset.level = level;
    cell.title = entry ? `${day}: ${entry.sessions} session(s)` : day;
    el.appendChild(cell);
  }
}

// ---------- activity trend chart ----------
document.querySelectorAll('.period-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.period-chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    state.period = chip.dataset.period;
    document.getElementById('customRange').classList.toggle('hidden', state.period !== 'custom');
    if (state.period !== 'custom') loadTimeseries();
  });
});

document.getElementById('applyRangeBtn').addEventListener('click', () => {
  if (!state.customFrom || !state.customTo) return;
  loadTimeseries();
});

// ---------- custom date picker (replaces native <input type=date>, whose
// popup calendar is an unstyleable OS control) ----------
const WEEKDAY_LABELS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const dp = {
  field: null,   // 'from' | 'to'
  viewDate: new Date(),
};

function isoDate(d) { return d.toISOString().slice(0, 10); }
function formatDisplayDate(isoStr) {
  const [y, m, d] = isoStr.split('-');
  return `${d}.${m}.${y}`;
}

function openDatePicker(field, triggerBtn) {
  dp.field = field;
  const existing = field === 'from' ? state.customFrom : state.customTo;
  dp.viewDate = existing ? new Date(existing) : new Date();
  renderDatePicker();

  const popup = document.getElementById('datePicker');
  const rect = triggerBtn.getBoundingClientRect();
  popup.style.top = `${rect.bottom + 6}px`;
  popup.style.left = `${Math.min(rect.left, window.innerWidth - 266)}px`;
  popup.classList.remove('hidden');
}

function closeDatePicker() {
  document.getElementById('datePicker').classList.add('hidden');
  dp.field = null;
}

function renderDatePicker() {
  const popup = document.getElementById('datePicker');
  const year = dp.viewDate.getFullYear();
  const month = dp.viewDate.getMonth();

  popup.querySelector('#dpMonthLabel').textContent =
    dp.viewDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const weekdaysEl = popup.querySelector('#dpWeekdays');
  weekdaysEl.innerHTML = WEEKDAY_LABELS.map((w) => `<span>${w}</span>`).join('');

  const firstOfMonth = new Date(year, month, 1);
  const startOffset = (firstOfMonth.getDay() + 6) % 7; // Monday-first grid
  const gridStart = new Date(year, month, 1 - startOffset);
  const todayStr = isoDate(new Date());
  const selectedStr = state.customFrom && state.customTo
    ? { from: state.customFrom, to: state.customTo } : null;

  const daysEl = popup.querySelector('#dpDays');
  daysEl.innerHTML = '';
  for (let i = 0; i < 42; i++) {
    const cellDate = new Date(gridStart);
    cellDate.setDate(gridStart.getDate() + i);
    const cellStr = isoDate(cellDate);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dp-day';
    btn.textContent = cellDate.getDate();
    if (cellDate.getMonth() !== month) btn.classList.add('outside');
    if (cellStr === todayStr) btn.classList.add('today');
    if (cellStr === state.customFrom || cellStr === state.customTo) btn.classList.add('selected');
    else if (selectedStr && cellStr > selectedStr.from && cellStr < selectedStr.to) btn.classList.add('in-range');
    btn.addEventListener('click', () => {
      if (dp.field === 'from') state.customFrom = cellStr;
      else state.customTo = cellStr;
      document.getElementById(dp.field === 'from' ? 'rangeFromBtn' : 'rangeToBtn').textContent = formatDisplayDate(cellStr);
      document.getElementById(dp.field === 'from' ? 'rangeFromBtn' : 'rangeToBtn').classList.add('set');
      closeDatePicker();
    });
    daysEl.appendChild(btn);
  }
}

document.getElementById('rangeFromBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  openDatePicker('from', e.currentTarget);
});
document.getElementById('rangeToBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  openDatePicker('to', e.currentTarget);
});
document.getElementById('dpPrev').addEventListener('click', () => {
  dp.viewDate.setMonth(dp.viewDate.getMonth() - 1);
  renderDatePicker();
});
document.getElementById('dpNext').addEventListener('click', () => {
  dp.viewDate.setMonth(dp.viewDate.getMonth() + 1);
  renderDatePicker();
});
document.getElementById('dpToday').addEventListener('click', () => {
  const todayStr = isoDate(new Date());
  if (dp.field === 'from') state.customFrom = todayStr;
  else state.customTo = todayStr;
  document.getElementById(dp.field === 'from' ? 'rangeFromBtn' : 'rangeToBtn').textContent = formatDisplayDate(todayStr);
  document.getElementById(dp.field === 'from' ? 'rangeFromBtn' : 'rangeToBtn').classList.add('set');
  closeDatePicker();
});
document.getElementById('dpClear').addEventListener('click', () => {
  if (dp.field === 'from') state.customFrom = null;
  else state.customTo = null;
  const btn = document.getElementById(dp.field === 'from' ? 'rangeFromBtn' : 'rangeToBtn');
  btn.textContent = 'select date';
  btn.classList.remove('set');
  closeDatePicker();
});
document.getElementById('datePicker').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => closeDatePicker());

async function loadTimeseries() {
  const granularity = state.period === 'custom' ? 'day' : state.period;
  const params = new URLSearchParams({ granularity });
  if (state.period === 'custom' && state.customFrom && state.customTo) {
    params.set('from', new Date(state.customFrom).toISOString());
    params.set('to', new Date(new Date(state.customTo).getTime() + 86_399_000).toISOString());
  }
  let data;
  try {
    data = await fetch(`/api/timeseries?${params}`).then((r) => r.json());
  } catch {
    return;
  }
  renderTrendChart(data.series || []);
}

let chartLoadWaitAttempts = 0;
function renderTrendChart(series) {
  // Chart.js loads from a CDN <script> tag; on a slow connection it can
  // still be in flight (or, rarely, the CDN can hiccup) when this first
  // runs. Retry briefly instead of throwing — and fall back to a plain
  // message if it never shows up rather than leaving a blank canvas.
  if (typeof Chart === 'undefined') {
    if (chartLoadWaitAttempts++ < 40) {
      setTimeout(() => renderTrendChart(series), 250);
    } else {
      document.getElementById('chartWrap').innerHTML =
        '<p style="color:#6b7a86;padding:10px;">Chart library failed to load from the CDN — check your network/firewall allows cdnjs.cloudflare.com or cdn.jsdelivr.net.</p>';
    }
    return;
  }

  const ctx = document.getElementById('activityChart');
  const labels = series.map((p) => p.label);
  const sessionCounts = series.map((p) => p.sessions);

  if (state.chart) {
    // Update in place rather than recreating — avoids the chart flashing
    // blank on every refresh, same reasoning as the mind map fix.
    state.chart.data.labels = labels;
    state.chart.data.datasets[0].data = sessionCounts;
    state.chart.update();
    return;
  }

  state.chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Sessions',
        data: sessionCounts,
        borderColor: '#00fff2',
        backgroundColor: 'rgba(0,255,242,0.12)',
        pointBackgroundColor: '#00fff2',
        pointRadius: 2,
        pointHoverRadius: 5,
        tension: 0.3,
        fill: true,
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      scales: {
        x: {
          ticks: { color: '#6b7a86', font: { family: 'Share Tech Mono', size: 10 }, maxRotation: 0, autoSkip: true },
          grid: { color: 'rgba(0,255,242,0.06)' },
        },
        y: {
          beginAtZero: true,
          ticks: { color: '#6b7a86', font: { family: 'Share Tech Mono', size: 10 }, precision: 0 },
          grid: { color: 'rgba(0,255,242,0.06)' },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#10121a',
          borderColor: '#00fff2',
          borderWidth: 1,
          titleColor: '#00fff2',
          bodyColor: '#d8fdf5',
          bodyFont: { family: 'Share Tech Mono' },
          titleFont: { family: 'Share Tech Mono' },
        },
      },
    },
  });
}

// ---------- sessions table ----------
function renderSessionsTable() {
  const filterAgent = document.getElementById('agentFilterSelect').value;
  const tbody = document.getElementById('sessionsBody');
  tbody.innerHTML = '';
  const rows = state.sessions.filter((s) => {
    if (!state.activeAgents.has(s.agent)) return false;
    if (filterAgent && s.agent !== filterAgent) return false;
    return true;
  });

  let totalSize = 0;
  for (const s of rows) {
    totalSize += s.size_bytes || 0;
    const tr = document.createElement('tr');
    const tokTotal = (s.tokens.input || 0) + (s.tokens.output || 0);
    tr.innerHTML = `
      <td><input type="checkbox" class="row-check" data-id="${esc(s.session_id)}" ${state.selectedSessionIds.has(s.session_id) ? 'checked' : ''}/></td>
      <td><span class="agent-badge ${esc(s.agent)}">${esc(s.agent)}</span></td>
      <td title="${esc(s.project)}">${esc(shorten(s.project))}</td>
      <td>${new Date(s.start_time).toLocaleString()}</td>
      <td>${formatDuration(new Date(s.end_time) - new Date(s.start_time))}</td>
      <td>${s.message_count}</td>
      <td>${tokTotal.toLocaleString()}</td>
      <td>${formatBytes(s.size_bytes || 0)}</td>
      <td><button class="row-del" data-id="${esc(s.session_id)}">delete</button></td>
    `;
    tbody.appendChild(tr);
  }
  document.getElementById('sessionsTotalSize').innerHTML =
    `${rows.length} session(s) &middot; <b>${formatBytes(totalSize)}</b> total`;

  tbody.querySelectorAll('.row-check').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) state.selectedSessionIds.add(cb.dataset.id);
      else state.selectedSessionIds.delete(cb.dataset.id);
      updateDeleteBtn();
    });
  });
  tbody.querySelectorAll('.row-del').forEach((btn) => {
    btn.addEventListener('click', () => deleteSession(btn.dataset.id));
  });
  updateDeleteBtn();
}

function updateDeleteBtn() {
  document.getElementById('deleteSelectedBtn').disabled = state.selectedSessionIds.size === 0;
}

document.getElementById('agentFilterSelect').addEventListener('change', renderSessionsTable);
document.getElementById('selectAll').addEventListener('change', (e) => {
  document.querySelectorAll('.row-check').forEach((cb) => {
    cb.checked = e.target.checked;
    if (e.target.checked) state.selectedSessionIds.add(cb.dataset.id);
    else state.selectedSessionIds.delete(cb.dataset.id);
  });
  updateDeleteBtn();
});

async function deleteSession(id) {
  openConfirmModal(`Delete session ${id.slice(0, 8)}? This removes the transcript file from disk permanently.`, async () => {
    await fetch(`/api/sessions/${id}?confirm=true`, { method: 'DELETE' });
    state.selectedSessionIds.delete(id);
    await loadAll();
  });
}

document.getElementById('deleteSelectedBtn').addEventListener('click', () => {
  const ids = [...state.selectedSessionIds];
  openConfirmModal(`Delete ${ids.length} session(s)? This removes the transcript files from disk permanently.`, async () => {
    await fetch('/api/sessions/delete-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, session_ids: ids }),
    });
    state.selectedSessionIds.clear();
    await loadAll();
  });
});

// ---------- modals ----------
function openConfirmModal(message, onConfirm) {
  const overlay = document.getElementById('modalOverlay');
  const box = document.getElementById('modalBox');
  box.innerHTML = `
    <h3>Confirm deletion</h3>
    <p>${message}</p>
    <div class="row">
      <button id="modalCancel">Cancel</button>
      <button id="modalOk" class="danger">Delete</button>
    </div>
  `;
  overlay.classList.remove('hidden');
  document.getElementById('modalCancel').onclick = () => overlay.classList.add('hidden');
  document.getElementById('modalOk').onclick = async () => {
    overlay.classList.add('hidden');
    await onConfirm();
  };
}

function openWipeModal(agent) {
  const expected = agent.toUpperCase();
  const overlay = document.getElementById('modalOverlay');
  const box = document.getElementById('modalBox');
  box.innerHTML = `
    <h3>Wipe ${agent} history</h3>
    <p>This permanently deletes ALL ${agent} session files from disk. This cannot be undone.</p>
    <p>Type <b>${expected}</b> to confirm:</p>
    <input type="text" id="wipeInput" autocomplete="off" />
    <div class="row">
      <button id="modalCancel">Cancel</button>
      <button id="modalOk" class="danger">Wipe ${agent}</button>
    </div>
  `;
  overlay.classList.remove('hidden');
  document.getElementById('modalCancel').onclick = () => overlay.classList.add('hidden');
  document.getElementById('modalOk').onclick = async () => {
    const val = document.getElementById('wipeInput').value;
    if (val !== expected) return;
    overlay.classList.add('hidden');
    await fetch(`/api/agents/${agent}/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm_name: expected }),
    });
    await loadAll();
  };
}

// ---------- live ticker + websocket ----------
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  const ticker = document.getElementById('tickerText');

  ws.addEventListener('message', (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === 'activity') {
      ticker.textContent = `${msg.agent} is currently writing in a session...`;
      ticker.style.color = AGENT_COLORS[msg.agent] || '#ff2fd0';
    } else if (msg.type === 'session_update' || msg.type === 'session_removed') {
      loadAll();
    }
  });

  ws.addEventListener('close', () => setTimeout(connectWs, 2000));
  ws.addEventListener('error', () => ws.close());
}

// idle ticker reset
setInterval(() => {
  const ticker = document.getElementById('tickerText');
  if (!ticker.dataset.lockUntil || Date.now() > Number(ticker.dataset.lockUntil)) {
    // no-op; activity messages already time out naturally via next poll
  }
}, 5000);

// Restore whatever tab the user had open before a reload. loadAll() runs
// first while the markup's default ("graph") tab is visible, so the mind
// map initializes at full size; only then do we switch to the persisted
// tab, if different.
loadAll().then(() => {
  let lastTab = 'graph';
  try { lastTab = localStorage.getItem(LAST_TAB_KEY) || 'graph'; } catch { /* private mode, etc. */ }
  if (lastTab !== 'graph') activateTab(lastTab, { persist: false });
});
connectWs();
setInterval(loadAll, 15000);
