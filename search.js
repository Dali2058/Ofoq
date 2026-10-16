// بحث على الإنترنت: Tavily لو فيه مفتاح، وإلا DuckDuckGo كحل احتياطي.

const UA = 'Mozilla/5.0 (compatible; OfoqBot/0.1)';

async function tavily(query) {
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
    body: JSON.stringify({ query, max_results: 5 }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`tavily ${r.status}`);
  const data = await r.json();
  return (data.results || []).map((x) => ({ title: x.title, url: x.url, snippet: (x.content || '').slice(0, 500) }));
}

const decode = (s) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

async function duckduckgo(query) {
  const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ar,en;q=0.8' },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`ddg ${r.status}`);
  const html = await r.text();
  const out = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && out.length < 5) {
    let url = m[1];
    const u = url.match(/uddg=([^&]+)/);
    if (u) url = decodeURIComponent(u[1]);
    if (url.startsWith('//')) url = 'https:' + url;
    out.push({ title: decode(m[2]), url, snippet: decode(m[3]).slice(0, 500) });
  }
  return out;
}

export async function webSearch(query) {
  const q = String(query || '').trim().slice(0, 300);
  if (!q) return 'استعلام البحث فاضي.';
  try {
    const results = process.env.TAVILY_API_KEY ? await tavily(q) : await duckduckgo(q);
    if (!results.length) return 'ملقيتش نتائج مناسبة.';
    return results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');
  } catch (e) {
    console.error('search failed:', e.message);
    return 'فشل البحث حاليًا. جاوب من معرفتك وقول للمستخدم إن البحث مش متاح دلوقتي.';
  }
}
