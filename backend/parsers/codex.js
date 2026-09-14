// Parser for Codex CLI session transcripts.
// Location: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
// Flat date-sharded tree; the real project path lives in the first line's
// session_meta.payload.cwd. No LLM calls — pure text/JSON parsing.

const fs = require('fs');
const path = require('path');
const { extractKeywords } = require('../lib/keywords');

function walkJsonlFiles(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walkJsonlFiles(full, out);
    } else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
}

function parseSessionFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split('\n').filter(Boolean);
  if (lines.length === 0) return null;

  let sessionId = path.basename(filePath).replace(/^rollout-/, '').replace(/\.jsonl$/, '');
  let project = null;
  let startTime = null;
  let endTime = null;
  let messageCount = 0;
  const toolsUsed = {};
  const filesTouched = new Set();
  const userTexts = [];
  let lastTokenUsage = null;
  let model = null;

  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = obj.timestamp;
    if (ts) {
      if (!startTime || ts < startTime) startTime = ts;
      if (!endTime || ts > endTime) endTime = ts;
    }

    if (obj.type === 'session_meta' && obj.payload) {
      if (obj.payload.id) sessionId = obj.payload.id;
      if (obj.payload.cwd) project = obj.payload.cwd;
      if (obj.payload.model) model = obj.payload.model;
      continue;
    }

    const payload = obj.payload;
    if (!payload) continue;

    if (payload.type === 'message') {
      messageCount++;
      if (payload.role === 'user' && Array.isArray(payload.content)) {
        for (const item of payload.content) {
          if (item.type === 'input_text' && item.text) userTexts.push(item.text);
        }
      }
    } else if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      const name = payload.name || 'tool';
      toolsUsed[name] = (toolsUsed[name] || 0) + 1;
      if (payload.arguments) {
        const m = /"(?:command|path|file_path)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(payload.arguments);
        if (m) {
          const val = m[1].replace(/\\\\/g, '\\');
          const pathMatch = /[A-Za-z]:\\[^"]+|\/[^"\s]+/.exec(val);
          if (pathMatch) filesTouched.add(pathMatch[0]);
        }
      }
    } else if (payload.type === 'token_count' && payload.info?.total_token_usage) {
      lastTokenUsage = payload.info.total_token_usage;
    }
  }

  if (!startTime) {
    const stat = fs.statSync(filePath);
    startTime = stat.mtime.toISOString(); // birthtime is unreliable over Docker bind mounts
  }
  if (!endTime) endTime = startTime;

  const tokens = lastTokenUsage
    ? {
      input: (lastTokenUsage.input_tokens || 0) - (lastTokenUsage.cached_input_tokens || 0),
      output: lastTokenUsage.output_tokens || 0,
      cache: lastTokenUsage.cached_input_tokens || 0,
    }
    : { input: 0, output: 0, cache: 0 };

  const stat = fs.statSync(filePath);

  return {
    agent: 'codex',
    project: project || 'unknown',
    project_raw: project,
    session_id: sessionId,
    session_file: filePath,
    start_time: startTime,
    end_time: endTime,
    message_count: messageCount,
    tools_used: toolsUsed,
    files_touched: [...filesTouched].slice(0, 50),
    tokens,
    model,
    keywords: extractKeywords(userTexts),
    mtime: stat.mtimeMs,
    size_bytes: stat.size,
  };
}

function scanAll(baseDir) {
  const sessions = [];
  const sessionsRoot = baseDir ? path.join(baseDir, 'sessions') : null;
  if (!sessionsRoot || !fs.existsSync(sessionsRoot)) return sessions;
  const files = [];
  walkJsonlFiles(sessionsRoot, files);
  for (const f of files) {
    try {
      const parsed = parseSessionFile(f);
      if (parsed) sessions.push(parsed);
    } catch {
      // skip unparsable file
    }
  }
  return sessions;
}

module.exports = { scanAll, parseSessionFile };
