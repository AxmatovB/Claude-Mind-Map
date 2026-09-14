function dayKey(iso) {
  return new Date(iso).toISOString().slice(0, 10);
}

function computeStats(sessions) {
  const totals = { sessions: sessions.length, tokens: { input: 0, output: 0, cache: 0 } };
  const byDay = new Map(); // 'YYYY-MM-DD' -> { sessions, tokens }
  const modelCount = new Map();
  const byAgent = {};
  let longest = null;

  for (const s of sessions) {
    totals.tokens.input += s.tokens?.input || 0;
    totals.tokens.output += s.tokens?.output || 0;
    totals.tokens.cache += s.tokens?.cache || 0;

    byAgent[s.agent] = byAgent[s.agent] || { sessions: 0, tokens: { input: 0, output: 0, cache: 0 } };
    byAgent[s.agent].sessions++;
    byAgent[s.agent].tokens.input += s.tokens?.input || 0;
    byAgent[s.agent].tokens.output += s.tokens?.output || 0;
    byAgent[s.agent].tokens.cache += s.tokens?.cache || 0;

    if (s.model) modelCount.set(s.model, (modelCount.get(s.model) || 0) + 1);

    const durationMs = new Date(s.end_time).getTime() - new Date(s.start_time).getTime();
    if (!longest || durationMs > longest.durationMs) {
      longest = { session_id: s.session_id, agent: s.agent, project: s.project, durationMs };
    }

    let day;
    try {
      day = dayKey(s.start_time);
    } catch {
      continue;
    }
    if (!byDay.has(day)) byDay.set(day, { day, sessions: 0, tokens: 0 });
    const entry = byDay.get(day);
    entry.sessions++;
    entry.tokens += (s.tokens?.input || 0) + (s.tokens?.output || 0);
  }

  const days = [...byDay.keys()].sort();
  let currentStreak = 0;
  let longestStreak = 0;
  let run = 0;
  let prevDay = null;
  for (const d of days) {
    if (prevDay) {
      const diff = (new Date(d) - new Date(prevDay)) / 86400000;
      run = diff === 1 ? run + 1 : 1;
    } else {
      run = 1;
    }
    longestStreak = Math.max(longestStreak, run);
    prevDay = d;
  }
  if (days.length) {
    const today = new Date().toISOString().slice(0, 10);
    const lastDay = days[days.length - 1];
    const gap = (new Date(today) - new Date(lastDay)) / 86400000;
    currentStreak = gap <= 1 ? run : 0;
  }

  const favoriteModel = [...modelCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  return {
    total_sessions: totals.sessions,
    total_tokens: totals.tokens,
    by_agent: byAgent,
    favorite_model: favoriteModel,
    longest_session: longest,
    active_days: days.length,
    current_streak: currentStreak,
    longest_streak: longestStreak,
    heatmap: [...byDay.values()],
  };
}

const MS = { hour: 3_600_000, day: 86_400_000 };

function bucketStart(date, granularity) {
  const d = new Date(date);
  if (granularity === 'hour') {
    d.setMinutes(0, 0, 0);
    return d;
  }
  if (granularity === 'year') {
    return new Date(Date.UTC(d.getFullYear(), 0, 1));
  }
  d.setHours(0, 0, 0, 0);
  return d;
}

function bucketKey(d, granularity) {
  if (granularity === 'hour') return d.toISOString().slice(0, 13) + ':00';
  if (granularity === 'year') return String(d.getUTCFullYear());
  return d.toISOString().slice(0, 10);
}

function bucketLabel(d, granularity) {
  if (granularity === 'hour') {
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit' });
  }
  if (granularity === 'year') return String(d.getUTCFullYear());
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function stepBucket(d, granularity) {
  const next = new Date(d);
  if (granularity === 'hour') next.setHours(next.getHours() + 1);
  else if (granularity === 'year') next.setFullYear(next.getFullYear() + 1);
  else next.setDate(next.getDate() + 1);
  return next;
}

// Zero-filled time series for the activity line chart. granularity is
// 'hour' | 'day' | 'year'; from/to are optional ISO bounds (defaults are
// sane recent windows per granularity so the chart isn't empty by default).
function computeTimeseries(sessions, { granularity = 'day', from, to } = {}) {
  const g = ['hour', 'day', 'year'].includes(granularity) ? granularity : 'day';
  const now = new Date();
  let toDate = to ? new Date(to) : now;
  let fromDate;
  if (from) {
    fromDate = new Date(from);
  } else if (g === 'hour') {
    fromDate = new Date(toDate.getTime() - 47 * MS.hour);
  } else if (g === 'year') {
    const years = sessions.map((s) => new Date(s.start_time).getUTCFullYear()).filter((y) => !Number.isNaN(y));
    const minYear = years.length ? Math.min(...years) : now.getUTCFullYear();
    fromDate = new Date(Date.UTC(minYear, 0, 1));
  } else {
    fromDate = new Date(toDate.getTime() - 89 * MS.day);
  }
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || fromDate > toDate) {
    fromDate = bucketStart(now, g);
    toDate = now;
  }

  const counts = new Map(); // bucketKey -> { sessions, tokens }
  for (const s of sessions) {
    const t = new Date(s.start_time);
    if (Number.isNaN(t.getTime()) || t < fromDate || t > toDate) continue;
    const key = bucketKey(bucketStart(t, g), g);
    if (!counts.has(key)) counts.set(key, { sessions: 0, tokens: 0 });
    const entry = counts.get(key);
    entry.sessions++;
    entry.tokens += (s.tokens?.input || 0) + (s.tokens?.output || 0);
  }

  const series = [];
  let cursor = bucketStart(fromDate, g);
  const end = bucketStart(toDate, g);
  let guard = 0;
  while (cursor <= end && guard < 5000) {
    const key = bucketKey(cursor, g);
    const entry = counts.get(key) || { sessions: 0, tokens: 0 };
    series.push({ bucket: key, label: bucketLabel(cursor, g), sessions: entry.sessions, tokens: entry.tokens });
    cursor = stepBucket(cursor, g);
    guard++;
  }
  return { granularity: g, from: fromDate.toISOString(), to: toDate.toISOString(), series };
}

module.exports = { computeStats, computeTimeseries };
