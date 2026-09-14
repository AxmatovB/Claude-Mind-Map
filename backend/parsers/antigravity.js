// Parser for Google Antigravity (antigravity-cli) session transcripts.
// Antigravity is a distinct product from Gemini CLI, though it lives under
// the same ~/.gemini home directory — different storage format entirely.
// Location: ~/.gemini/antigravity-cli/brain/<session-uuid>/.system_generated/logs/transcript.jsonl
// Human-readable session titles live separately at:
//   ~/.gemini/antigravity-cli/annotations/<session-uuid>.pbtxt  (a single
//   line of protobuf text format: title:"...")
// No LLM calls — pure text/JSON parsing.

const fs = require('fs');
const path = require('path');
const { extractKeywords } = require('../lib/keywords');

function readTitle(annotationsDir, sessionId) {
  const file = path.join(annotationsDir, `${sessionId}.pbtxt`);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const m = /title:"((?:[^"\\]|\\.)*)"/.exec(raw);
    if (m) return m[1].replace(/\\"/g, '"');
  } catch {
    // no annotation file for this session — fine, we just have no title
  }
  return null;
}

function stripTags(text) {
  // USER_INPUT content wraps the actual request in <USER_REQUEST>...</USER_REQUEST>
  // plus various <ADDITIONAL_METADATA>/<USER_SETTINGS_CHANGE> blocks we don't
  // want polluting keyword extraction.
  const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(text);
  return m ? m[1] : text;
}

function parseSessionFile(filePath, sessionId, annotationsDir) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split('\n').filter(Boolean);
  if (lines.length === 0) return null;

  let startTime = null;
  let endTime = null;
  let messageCount = 0;
  const toolsUsed = {};
  const userTexts = [];

  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = obj.created_at;
    if (ts) {
      if (!startTime || ts < startTime) startTime = ts;
      if (!endTime || ts > endTime) endTime = ts;
    }

    if (obj.type === 'USER_INPUT') {
      messageCount++;
      if (obj.content) userTexts.push(stripTags(obj.content));
    } else if (obj.type === 'PLANNER_RESPONSE') {
      messageCount++;
    } else if (obj.type === 'GENERIC') {
      // No explicit tool-name field is stored — every GENERIC entry is a
      // command/tool execution result, bucketed generically as "Command".
      toolsUsed.Command = (toolsUsed.Command || 0) + 1;
    }
  }

  if (!startTime) {
    const stat = fs.statSync(filePath);
    startTime = stat.mtime.toISOString();
  }
  if (!endTime) endTime = startTime;

  const stat = fs.statSync(filePath);
  const title = readTitle(annotationsDir, sessionId);

  return {
    agent: 'antigravity',
    project: title || `Antigravity session ${sessionId.slice(0, 8)}`,
    project_raw: sessionId,
    session_id: sessionId,
    session_file: filePath,
    start_time: startTime,
    end_time: endTime,
    message_count: messageCount,
    tools_used: toolsUsed,
    files_touched: [],
    tokens: { input: 0, output: 0, cache: 0 }, // not present in Antigravity transcripts
    model: null,
    keywords: extractKeywords(userTexts),
    mtime: stat.mtimeMs,
    size_bytes: stat.size,
  };
}

function scanAll(baseDir) {
  const sessions = [];
  const brainRoot = baseDir ? path.join(baseDir, 'brain') : null;
  const annotationsDir = baseDir ? path.join(baseDir, 'annotations') : null;
  if (!brainRoot || !fs.existsSync(brainRoot)) return sessions;

  let sessionDirs;
  try {
    sessionDirs = fs.readdirSync(brainRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return sessions;
  }

  for (const dirent of sessionDirs) {
    const transcriptFile = path.join(
      brainRoot, dirent.name, '.system_generated', 'logs', 'transcript.jsonl'
    );
    if (!fs.existsSync(transcriptFile)) continue;
    try {
      const parsed = parseSessionFile(transcriptFile, dirent.name, annotationsDir);
      if (parsed) sessions.push(parsed);
    } catch {
      // skip unparsable file
    }
  }
  return sessions;
}

module.exports = { scanAll, parseSessionFile };
