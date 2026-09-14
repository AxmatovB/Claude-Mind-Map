// Parser for Gemini CLI session transcripts.
// Location: ~/.gemini/tmp/<project-hash>/chats/session-*.jsonl
// ~/.gemini/projects.json maps real cwd -> folder slug (not the hash used
// under tmp/, so we fall back to the folder name itself for display).
// No LLM calls — pure text/JSON parsing.

const fs = require('fs');
const path = require('path');
const { extractKeywords } = require('../lib/keywords');

function loadProjectsMap(baseDir) {
  const map = new Map(); // folderSlug -> real path
  const file = path.join(baseDir, 'projects.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.projects) {
      for (const [realPath, slug] of Object.entries(data.projects)) {
        map.set(slug, realPath);
      }
    }
  } catch {
    // no projects.json, or unreadable — fall back to folder names
  }
  return map;
}

function parseSessionFile(filePath, projectLabel) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split('\n').filter(Boolean);
  if (lines.length === 0) return null;

  let sessionId = path.basename(filePath, '.jsonl').replace(/^session-/, '');
  let startTime = null;
  let endTime = null;
  let messageCount = 0;
  const toolsUsed = {};
  const filesTouched = new Set();
  const userTexts = [];

  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.sessionId) sessionId = obj.sessionId;
    if (obj.startTime && (!startTime || obj.startTime < startTime)) startTime = obj.startTime;
    const ts = obj.timestamp || obj.lastUpdated;
    if (ts) {
      if (!startTime || ts < startTime) startTime = ts;
      if (!endTime || ts > endTime) endTime = ts;
    }

    if (obj.type === 'user' || obj.type === 'gemini') {
      messageCount++;
      const content = obj.content;
      if (obj.type === 'user') {
        if (typeof content === 'string') userTexts.push(content);
        else if (Array.isArray(content)) {
          for (const c of content) if (c.text) userTexts.push(c.text);
        }
      }
      if (Array.isArray(obj.toolCalls)) {
        for (const tc of obj.toolCalls) {
          const name = tc.name || tc.toolName || 'tool';
          toolsUsed[name] = (toolsUsed[name] || 0) + 1;
          const p = tc.args?.file_path || tc.args?.path || tc.args?.absolute_path;
          if (p) filesTouched.add(p);
        }
      }
    } else if (obj.type === 'tool_call' || obj.type === 'toolCall') {
      const name = obj.name || obj.toolName || 'tool';
      toolsUsed[name] = (toolsUsed[name] || 0) + 1;
    }
  }

  if (!startTime) {
    const stat = fs.statSync(filePath);
    startTime = stat.mtime.toISOString(); // birthtime is unreliable over Docker bind mounts
  }
  if (!endTime) endTime = startTime;

  const stat = fs.statSync(filePath);

  return {
    agent: 'gemini',
    project: projectLabel,
    project_raw: projectLabel,
    session_id: sessionId,
    session_file: filePath,
    start_time: startTime,
    end_time: endTime,
    message_count: messageCount,
    tools_used: toolsUsed,
    files_touched: [...filesTouched].slice(0, 50),
    tokens: { input: 0, output: 0, cache: 0 }, // not present in gemini transcripts
    model: null,
    keywords: extractKeywords(userTexts),
    mtime: stat.mtimeMs,
    size_bytes: stat.size,
  };
}

function scanAll(baseDir) {
  const sessions = [];
  const tmpRoot = baseDir ? path.join(baseDir, 'tmp') : null;
  if (!tmpRoot || !fs.existsSync(tmpRoot)) return sessions;

  const projectsMap = loadProjectsMap(baseDir);
  let projectFolders;
  try {
    projectFolders = fs.readdirSync(tmpRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return sessions;
  }

  for (const dirent of projectFolders) {
    const chatsDir = path.join(tmpRoot, dirent.name, 'chats');
    if (!fs.existsSync(chatsDir)) continue;
    const label = projectsMap.get(dirent.name) || dirent.name;
    let files;
    try {
      files = fs.readdirSync(chatsDir).filter((f) => f.startsWith('session-') && f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const full = path.join(chatsDir, f);
      try {
        const parsed = parseSessionFile(full, label);
        if (parsed) sessions.push(parsed);
      } catch {
        // skip unparsable file
      }
    }
  }
  return sessions;
}

module.exports = { scanAll, parseSessionFile };
