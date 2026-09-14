// Zero-LLM, deterministic keyword extraction: simple frequency count over
// alphabetic tokens, filtered against a small stopword list. No API calls.

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'has', 'you',
  'your', 'are', 'was', 'were', 'will', 'would', 'could', 'should', 'can',
  'not', 'but', 'all', 'any', 'now', 'then', 'than', 'when', 'what', 'which',
  'who', 'how', 'why', 'where', 'into', 'onto', 'about', 'above', 'below',
  'please', 'just', 'like', 'also', 'some', 'each', 'every', 'more', 'most',
  'other', 'such', 'only', 'own', 'same', 'here', 'there', 'their', 'them',
  'they', 'his', 'her', 'its', 'our', 'out', 'over', 'under', 'again',
  'once', 'because', 'while', 'these', 'those', 'been', 'being', 'does',
  'did', 'doing', 'file', 'files', 'code', 'need', 'want', 'make', 'made',
  'using', 'use', 'used', 'see', 'look', 'let', 'get', 'got', 'add',
  'added', 'change', 'changed', 'fix', 'fixed', 'yes', 'no', 'okay', 'ok',
]);

function extractKeywords(texts, limit = 8) {
  const freq = new Map();
  for (const text of texts) {
    if (!text || typeof text !== 'string') continue;
    const words = text
      .toLowerCase()
      .replace(/[`*_#>[\](){}<>]/g, ' ')
      .split(/[^a-z0-9_./\\-]+/i);
    for (let w of words) {
      w = w.trim();
      if (w.length < 5 || w.length > 40) continue;
      if (STOPWORDS.has(w)) continue;
      if (/^\d+$/.test(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word, count]) => ({ word, count }));
}

module.exports = { extractKeywords };
