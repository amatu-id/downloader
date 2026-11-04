// amatu-dl — the part of Downloader a browser cannot do by itself (no MacBook involved):
//   GET ?a=ig&code=<shortcode>            public Instagram post/reel → { user, fullname, text, date, code, items }
//   GET ?a=threads&u=<post url>           public Threads post → same shape
//   GET ?a=resolve&u=<short link>         final address of t.co / vm.tiktok.com / threads /t/ links
//   GET ?a=get&u=<cdn url>&s=<token>      streams a photo/video from the sites' own CDNs, for hosts without CORS
// Header x-amatu (or &s=) = portal session token, checked with amt_status.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-amatu, range',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Expose-Headers': 'content-length, content-range, accept-ranges, content-type',
};
const SB = Deno.env.get('SUPABASE_URL')!, ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const OPEN = Deno.env.get('AMATU_DL_OPEN') === '1'; // test copy only
// deno-lint-ignore no-explicit-any
type J = any;
const out = (o: J, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
class Err extends Error { constructor(public status: number, m: string) { super(m); } }

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const PAGE = {
  'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1', 'Upgrade-Insecure-Requests': '1',
  'sec-ch-ua': '"Chromium";v="141", "Google Chrome";v="141", "Not?A_Brand";v="8"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"macOS"',
};
const CDN = /(^|\.)(twimg\.com|cdninstagram\.com|fbcdn\.net|tiktokcdn\.com|tiktokcdn-us\.com|tikwm\.com)$/i;
const SHORT = /(^|\.)(t\.co|tiktok\.com|threads\.com|threads\.net|instagr\.am|instagram\.com)$/i;
const okUrl = (u: string) => { try { const x = new URL(u); return x.protocol === 'https:' && CDN.test(x.hostname); } catch { return false; } };
const isoDate = (v: J) => { const d = new Date(v); return isNaN(+d) ? '' : d.toISOString().slice(0, 10); };
const unent = (s: J) => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

const sessions = new Map<string, number>();
async function guard(tok: string) {
  if (OPEN) return;
  if (!tok) throw new Err(401, 'Silakan masuk ke Portal AMATU dulu.');
  if ((sessions.get(tok) || 0) > Date.now()) return;
  const r = await fetch(`${SB}/rest/v1/rpc/amt_status`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_token: tok }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.user) throw new Err(401, 'Sesi Portal AMATU berakhir. Silakan masuk lagi.');
  sessions.set(tok, Date.now() + 10 * 60e3);
}

function findPost(root: J, code: string, key = 'code') {
  const stack = [root];
  while (stack.length) {
    const o = stack.pop();
    if (!o || typeof o !== 'object') continue;
    if (!Array.isArray(o) && o[key] === code && ('media_type' in o || 'is_video' in o || '__typename' in o || 'edge_sidecar_to_children' in o)) return o;
    for (const k in o) if (o[k] && typeof o[k] === 'object') stack.push(o[k]);
  }
  return null;
}

// ---------- Threads / Instagram app-style media objects ----------
function dashOf(mpd: string) {
  if (!mpd) return {} as J;
  const t = /mediaPresentationDuration="PT(?:(\d+)H)?(?:(\d+)M)?([\d.]+)S"/.exec(mpd);
  const dur = t ? (+t[1] || 0) * 3600 + (+t[2] || 0) * 60 + +t[3] : 0;
  const reps = [...mpd.matchAll(/<Representation\s([^>]*)>(.*?)<\/Representation>/gs)].map((m) => {
    const at = (k: string) => new RegExp(`\\b${k}="([^"]*)"`).exec(m[1])?.[1] || '';
    return { mime: at('mimeType'), w: +at('width') || 0, h: +at('height') || 0, bw: +at('bandwidth') || 0, url: unent(/<BaseURL[^>]*>(.*?)<\/BaseURL>/s.exec(m[2])?.[1]) };
  }).filter((r) => okUrl(r.url));
  const v = reps.filter((r) => r.mime.startsWith('video')).sort((a, b) => b.w * b.h - a.w * a.h || b.bw - a.bw)[0];
  const a = reps.filter((r) => r.mime.startsWith('audio')).sort((a, b) => b.bw - a.bw)[0];
  return { dur, dash: v && Math.min(v.w, v.h) > 720 ? { v: v.url, a: a?.url, w: v.w, h: v.h } : undefined };
}
function appMedia(m: J) {
  const best = (m.image_versions2?.candidates || []).filter((c: J) => okUrl(c.url)).sort((a: J, b: J) => (b.width || 0) - (a.width || 0))[0];
  const vid = (m.video_versions || []).find((v: J) => okUrl(v.url));
  const w = m.original_width || best?.width || 0, h = m.original_height || best?.height || 0;
  if (vid) { const d = dashOf(m.video_dash_manifest); return { type: 'video', url: vid.url, dash: d.dash, thumb: best?.url, w, h, dur: d.dur || m.video_duration || 0, ext: 'mp4' }; }
  if (best && m.media_type !== 19) return { type: 'image', url: best.url, thumb: best.url, w, h, ext: 'jpg' };
  return null;
}

async function threads(url: string) {
  const code = /\/(?:post|t)\/([\w-]+)/.exec(url)?.[1];
  if (!code) throw new Err(422, 'Link Threads tidak dikenali.');
  const r = await fetch(url, { headers: PAGE, signal: AbortSignal.timeout(30000) });
  if (r.status === 429) throw new Err(429, 'Threads membatasi permintaan. Coba lagi beberapa menit lagi.');
  const html = await r.text();
  let post: J = null;
  for (const m of html.matchAll(/<script type="application\/json"[^>]*data-sjs>(.*?)<\/script>/gs)) {
    if (!m[1].includes(`"code":"${code}"`)) continue;
    try { post = findPost(JSON.parse(m[1]), code); } catch { /* next block */ }
    if (post) break;
  }
  if (!post) throw new Err(422, 'Postingan Threads tidak ditemukan — mungkin sudah dihapus atau akunnya privat.');
  const list = (p: J) => (p.carousel_media?.length ? p.carousel_media : [p]).map(appMedia).filter(Boolean);
  const own = list(post), info = post.text_post_app_info?.share_info, shared = info?.quoted_post || info?.reposted_post;
  const items = own.length || !shared ? own : list(shared);
  const lp = post.text_post_app_info?.link_preview_attachment;
  let lpUrl = lp?.url || '';
  try { lpUrl = new URL(lpUrl).searchParams.get('u') || lpUrl; } catch { /* as is */ }
  return {
    user: post.user?.username || '', fullname: post.user?.full_name || '', text: String(post.caption?.text || shared?.caption?.text || (lp ? [lp.title, lpUrl].filter(Boolean).join('\n') : '')).trim(),
    date: post.taken_at ? isoDate(post.taken_at * 1000) : '', code, avatar: post.user?.profile_pic_url || '', items,
  };
}

// ---------- Instagram (public posts, no login) ----------
function igGql(m: J) {
  const one = (n: J) => n.is_video || n.video_url
    ? { type: 'video', url: n.video_url, thumb: n.display_url, w: n.dimensions?.width || 0, h: n.dimensions?.height || 0, dur: n.video_duration || 0, ext: 'mp4' }
    : { type: 'image', url: n.display_url, thumb: n.display_url, w: n.dimensions?.width || 0, h: n.dimensions?.height || 0, ext: 'jpg' };
  const kids = m.edge_sidecar_to_children?.edges?.map((e: J) => e.node);
  const items = (kids?.length ? kids : [m]).map(one).filter((x: J) => x.url);
  return {
    user: m.owner?.username || '', fullname: m.owner?.full_name || '', text: String(m.edge_media_to_caption?.edges?.[0]?.node?.text || '').trim(),
    date: m.taken_at_timestamp ? isoDate(m.taken_at_timestamp * 1000) : '', code: m.shortcode, avatar: m.owner?.profile_pic_url || '', items,
  };
}
async function igGraphql(code: string) {
  const body = new URLSearchParams({ variables: JSON.stringify({ shortcode: code }), doc_id: '8845758582119845', lsd: 'AVqbxe3J_YA', fb_api_req_friendly_name: 'PolarisPostActionLoadPostQueryQuery', server_timestamps: 'true' });
  const r = await fetch('https://www.instagram.com/graphql/query', {
    method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'X-IG-App-ID': '936619743392459', 'X-FB-LSD': 'AVqbxe3J_YA', 'X-ASBD-ID': '129477', 'Sec-Fetch-Site': 'same-origin', Origin: 'https://www.instagram.com', Referer: `https://www.instagram.com/p/${code}/` },
    body,
  });
  const t = await r.text();
  try { const m = JSON.parse(t)?.data?.xdt_shortcode_media; return { m: m ? igGql(m) : null, why: 'gql ' + r.status + (m ? '' : ' ' + t.slice(0, 80)) }; }
  catch { return { m: null, why: 'gql ' + r.status + ' ' + t.slice(0, 80) }; }
}
async function igEmbed(code: string) {
  const r = await fetch(`https://www.instagram.com/p/${code}/embed/captioned/`, { headers: { ...PAGE, 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Site': 'cross-site' }, signal: AbortSignal.timeout(20000) });
  const html = await r.text();
  const cj = /\\"gql_data\\":(\{.*?\})\s*,\\"[a-z_]+\\":/s.exec(html);
  const ctx = /"contextJSON":"((?:[^"\\]|\\.)*)"/.exec(html);
  if (ctx) {
    try {
      const j = JSON.parse(JSON.parse(`"${ctx[1]}"`));
      const m = j?.gql_data?.shortcode_media || j?.context?.media || j?.shortcode_media;
      if (m) return { m: igGql(m), why: 'embed json' };
    } catch { /* parse the page instead */ }
  }
  const img = /class="EmbeddedMediaImage"[^>]*src="([^"]+)"/.exec(html)?.[1];
  const isVideo = /"is_video":true|data-media-type="GraphVideo"|Sprite Play/.test(html);
  if (img && !isVideo) {
    const user = /class="UsernameText">([^<]+)</.exec(html)?.[1] || '';
    const cap = /class="Caption"[^>]*>(.*?)<div class="CaptionComments/s.exec(html)?.[1]?.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '').trim() || '';
    const u = unent(img);
    return { m: { user, fullname: '', text: unent(cap).replace(new RegExp('^' + user + '\\s*'), ''), date: '', code, avatar: '', items: [{ type: 'image', url: u, thumb: u, w: 0, h: 0, ext: 'jpg' }] }, why: 'embed img' };
  }
  return { m: null, why: 'embed ' + r.status + ' len ' + html.length + (cj ? ' cj' : '') + (isVideo ? ' video' : '') };
}
async function ig(code: string) {
  const why: string[] = [];
  for (const f of [igGraphql, igEmbed]) {
    try { const x = await f(code); why.push(x.why); if (x.m?.items?.length) return x.m; } catch (e) { why.push(String(e)); }
  }
  console.log('ig', code, why.join(' | '));
  throw new Err(422, 'Postingan Instagram ini tidak bisa dibuka tanpa login (akun privat, story, atau dibatasi Instagram). Coba postingan publik lain.');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const q = new URL(req.url).searchParams, a = q.get('a'), u = q.get('u') || '';
  try {
    await guard(req.headers.get('x-amatu') || q.get('s') || '');
    if (a === 'ig') return out(await ig(q.get('code') || ''));
    if (a === 'threads') {
      if (!/^https:\/\/(www\.)?threads\.(com|net)\//.test(u)) throw new Err(422, 'Link Threads tidak dikenali.');
      return out(await threads(u));
    }
    if (a === 'resolve') {
      const x = new URL(u);
      if (x.protocol !== 'https:' || !SHORT.test(x.hostname)) throw new Err(422, 'Link tidak dikenali.');
      const r = await fetch(u, { headers: PAGE, redirect: 'follow', signal: AbortSignal.timeout(15000) });
      r.body?.cancel();
      return out({ url: r.url });
    }
    if (a === 'get') {
      if (!okUrl(u)) throw new Err(403, 'Alamat berkas tidak diizinkan.');
      const h: Record<string, string> = { 'User-Agent': UA };
      const range = req.headers.get('range');
      if (range) h.Range = range;
      const r = await fetch(u, { headers: h });
      const head = new Headers(CORS);
      for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) { const v = r.headers.get(k); if (v) head.set(k, v); }
      return new Response(r.body, { status: r.status, headers: head });
    }
    throw new Err(400, 'Permintaan tidak dikenali.');
  } catch (e) {
    return out({ error: e instanceof Err ? e.message : 'Sumber sedang tidak bisa dihubungi. Coba lagi sebentar lagi.' }, e instanceof Err ? e.status : 502);
  }
});
