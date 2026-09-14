// Parser for Claude Code session transcripts.
// Location: ~/.claude/projects/<encoded-project>/<session-id>.jsonl
// One JSON object per line. No LLM calls — pure text/JSON parsing.

const fs = require('fs');
const path = require('path');
const { extractKeywords } = require('../lib/keywords');

function decodeProjectFolder(folderName) {
  // Claude encodes the absolute project path by replacing path separators
  // with "-". This is lossy (dashes in real folder names collide), so this
  // is a best-effort display decode, not a reversible one.
  if (!folderName.startsWith('C--') && !/^[A-Za-z]--/.test(folderName)) {
    return folderName.replace(/-/g, path.sep);
  }
  const drive = folderName[0];
  const rest = folderName.slice(3).replace(/-/g, '\\');
  return `${drive}:\\${rest}`;
}

function extractFilePathFromInput(input) {
  if (!input || typeof input !== 'object') return null;
  return input.file_path || input.path || input.notebook_path || null;
}

function parseSessionFile(filePath, projectFolder) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split('\n').filter(Boolean);
  if (lines.length === 0) return null;

  let sessionId = path.basename(filePath, '.jsonl');
  let startTime = null;
  let endTime = null;
  let messageCount = 0;
  const toolsUsed = {};
  const filesTouched = new Set();
  const userTexts = [];
  let tokens = { input: 0, output: 0, cache: 0 };
  let model = null;

  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (obj.sessionId) sessionId = obj.sessionId;
    const ts = obj.timestamp;
    if (ts) {
      if (!startTime || ts < startTime) startTime = ts;
      if (!endTime || ts > endTime) endTime = ts;
    }

    if (obj.type === 'user' || obj.type === 'assistant') {
      messageCount++;
      const msg = obj.message;
      if (msg && Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (!item || typeof item !== 'object') continue;
          if (item.type === 'text' && obj.type === 'user') {
            userTexts.push(item.text);
          }
          if (item.type === 'tool_use' && item.name) {
            toolsUsed[item.name] = (toolsUsed[item.name] || 0) + 1;
            const fp = extractFilePathFromInput(item.input);
            if (fp) filesTouched.add(fp);
          }
        }
      } else if (typeof msg?.content === 'string' && obj.type === 'user') {
        userTexts.push(msg.content);
      }
      if (msg?.model) model = msg.model;
      if (msg?.usage) {
        tokens.input += msg.usage.input_tokens || 0;
        tokens.output += msg.usage.output_tokens || 0;
        tokens.cache += (msg.usage.cache_creation_input_tokens || 0) +
          (msg.usage.cache_read_input_tokens || 0);
      }
    } else if (obj.type === 'queue-operation' && obj.content) {
      userTexts.push(obj.content);
    }
  }

  if (!startTime) {
    const stat = fs.statSync(filePath);
    startTime = stat.mtime.toISOString(); // birthtime is unreliable over Docker bind mounts
  }
  if (!endTime) endTime = startTime;

  const stat = fs.statSync(filePath);

  return {
    agent: 'claude',
    project: decodeProjectFolder(projectFolder),
    project_raw: projectFolder,
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
  const projectsRoot = baseDir ? path.join(baseDir, 'projects') : null;
  if (!projectsRoot || !fs.existsSync(projectsRoot)) return sessions;
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(projectsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory());
  } catch {
    return sessions;
  }
  for (const dirent of projectDirs) {
    const projectPath = path.join(projectsRoot, dirent.name);
    let files;
    try {
      files = fs.readdirSync(projectPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const full = path.join(projectPath, f);
      try {
        const parsed = parseSessionFile(full, dirent.name);
        if (parsed) sessions.push(parsed);
      } catch {
        // skip unparsable file
      }
    }
  }
  return sessions;
}

module.exports = { scanAll, parseSessionFile, decodeProjectFolder };
