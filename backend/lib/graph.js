// Builds a nodes/edges graph from parsed sessions:
// hub -> agent -> project -> session -> {tool, file/topic} leaves.

const AGENT_LABEL = { claude: 'Claude Code', codex: 'Codex CLI', gemini: 'Gemini CLI' };

function buildGraph(sessions) {
  const nodes = new Map();
  const edges = [];

  const addNode = (id, node) => {
    if (!nodes.has(id)) nodes.set(id, node);
    return id;
  };

  let totalSizeBytes = 0;
  addNode('hub', { id: 'hub', type: 'hub', label: 'Claude Brain' });

  const agentSeen = new Set();
  const projectSeen = new Set();
  const agentSize = new Map();
  const projectSize = new Map();

  for (const s of sessions) {
    const sizeBytes = s.size_bytes || 0;
    totalSizeBytes += sizeBytes;

    const agentId = `agent:${s.agent}`;
    if (!agentSeen.has(agentId)) {
      agentSeen.add(agentId);
      addNode(agentId, { id: agentId, type: 'agent', agent: s.agent, label: AGENT_LABEL[s.agent] || s.agent });
      edges.push({ source: 'hub', target: agentId });
    }
    agentSize.set(agentId, (agentSize.get(agentId) || 0) + sizeBytes);

    const projectKey = `proj:${s.agent}:${s.project}`;
    if (!projectSeen.has(projectKey)) {
      projectSeen.add(projectKey);
      addNode(projectKey, { id: projectKey, type: 'project', agent: s.agent, label: shortenPath(s.project) });
      edges.push({ source: agentId, target: projectKey });
    }
    projectSize.set(projectKey, (projectSize.get(projectKey) || 0) + sizeBytes);

    const sessionId = `session:${s.agent}:${s.session_id}`;
    addNode(sessionId, {
      id: sessionId,
      type: 'session',
      agent: s.agent,
      label: s.session_id.slice(0, 8),
      session_id: s.session_id,
      project: s.project,
      start_time: s.start_time,
      end_time: s.end_time,
      message_count: s.message_count,
      active: s.active || false,
      size_bytes: sizeBytes,
    });
    edges.push({ source: projectKey, target: sessionId });

    for (const [tool, count] of Object.entries(s.tools_used || {})) {
      const toolId = `tool:${tool}`;
      addNode(toolId, { id: toolId, type: 'tool', label: tool });
      edges.push({ source: sessionId, target: toolId, weight: count });
    }

    for (const kw of (s.keywords || []).slice(0, 4)) {
      const topicId = `topic:${s.agent}:${s.project}:${kw.word}`;
      addNode(topicId, { id: topicId, type: 'topic', label: kw.word });
      edges.push({ source: sessionId, target: topicId, weight: kw.count });
    }
  }

  const nodeList = [...nodes.values()];
  for (const n of nodeList) {
    if (n.type === 'hub') n.size_bytes = totalSizeBytes;
    else if (n.type === 'agent') n.size_bytes = agentSize.get(n.id) || 0;
    else if (n.type === 'project') n.size_bytes = projectSize.get(n.id) || 0;
  }

  return { nodes: nodeList, edges, total_size_bytes: totalSizeBytes };
}

function shortenPath(p) {
  if (!p) return 'unknown';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/') || p;
}

module.exports = { buildGraph };
