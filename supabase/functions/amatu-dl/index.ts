// amatu-dl — the part of Downloader a browser cannot do by itself (no MacBook involved):
//   GET ?a=ig&code=<shortcode>            public Instagram post/reel → { user, fullname, text, date, code, items }
//   GET ?a=threads&u=<post url>           public Threads post → same shape
//   GET ?a=fb&u=<post url>                public Facebook video / reel / photo / post → same shape
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
const SHORT = /(^|\.)(t\.co|tiktok\.com|threads\.com|threads\.net|instagr\.am|instagram\.com|facebook\.com|fb\.watch|fb\.com)$/i;
const FBHOST = /^https:\/\/(?:[a-z]+\.)?(?:facebook\.com|fb\.watch|fb\.com)\//i;
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
// The public embed page (what other websites show) — no login, no private API.
async function igEmbed(code: string, path: string) {
  const r = await fetch(`https://www.instagram.com/${path}/${code}/embed/captioned/`, { headers: { ...PAGE, 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Site': 'cross-site' }, signal: AbortSignal.timeout(20000) });
  if (r.status === 429) throw new Err(429, 'Instagram sedang membatasi permintaan. Coba lagi beberapa menit lagi.');
  const html = await r.text();
  const ctx = /"contextJSON":"((?:[^"\\]|\\.)*)"/.exec(html);
  if (ctx) {
    try {
      const j = JSON.parse(JSON.parse(`"${ctx[1]}"`));
      const m = j?.gql_data?.shortcode_media || j?.context?.media || j?.shortcode_media;
      if (m) return { m: igGql(m), why: 'embed json' };
    } catch { /* parse the page instead */ }
  }
  const tag = /<img[^>]*class="EmbeddedMediaImage"[^>]*>/.exec(html)?.[0] || '';
  const srcset = unent(/srcset="([^"]+)"/.exec(tag)?.[1] || '').split(/,\s*(?=https:)/).map((x) => { const [u, w] = x.trim().split(/\s+/); return { u, w: parseInt(w) || 0 }; }).filter((x) => x.u).sort((a, b) => b.w - a.w);
  const img = srcset[0]?.u || unent(/src="([^"]+)"/.exec(tag)?.[1] || '');
  const isVideo = /"is_video":true|data-media-type="GraphVideo"|Sprite Play|EmbedIsVideo|"video_url"/.test(html);
  if (img && !isVideo) {
    const user = /class="UsernameText">([^<]+)</.exec(html)?.[1] || '';
    const cap = /class="Caption"[^>]*>(.*?)<div class="CaptionComments/s.exec(html)?.[1]?.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '').trim() || '';
    return { m: { user, fullname: '', text: unent(cap).replace(new RegExp('^' + user.replace(/[.]/g, '\\.') + '\\s*'), ''), date: '', code, avatar: '', items: [{ type: 'image', url: img, thumb: img, w: srcset[0]?.w || 0, h: 0, ext: 'jpg' }] }, why: 'embed img' };
  }
  const off = /EmbedIsBroken|This post is unavailable|Postingan ini tidak tersedia/i.test(html);
  return { m: null, why: 'embed ' + r.status + ' len ' + html.length + (isVideo ? ' video' : '') + (off ? ' broken' : ''), off };
}
async function ig(code: string) {
  if (!/^[\w-]{5,40}$/.test(code)) throw new Err(422, 'Link Instagram tidak dikenali.');
  const why: string[] = [];
  let off = false;
  for (const path of ['p', 'reel']) {
    try { const x = await igEmbed(code, path); why.push(x.why); if (x.m?.items?.length) return x.m; off ||= !!x.off; } catch (e) { if (e instanceof Err) throw e; why.push(String(e)); }
  }
  console.log('ig', code, why.join(' | '));
  throw new Err(422, off
    ? 'Postingan Instagram ini tidak tersedia: sudah dihapus, akunnya privat, atau pemiliknya mematikan fitur sematan. Hanya postingan & reels dari akun publik yang bisa diunduh.'
    : 'Instagram tidak mengirim isi postingan ini. Pastikan akunnya publik, lalu coba lagi sebentar lagi.');
}

// ---------- Facebook (public videos, reels, photos, posts; no login) ----------
function fbBlocks(html: string) {
  const out: J[] = [];
  for (const m of html.matchAll(/<script type="application\/json"[^>]*>(.*?)<\/script>/gs)) {
    const t = m[1];
    if (!/browser_native_|playable_url|photo_image|"__typename":"Photo"|creation_time|"message":\{"text"/.test(t)) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip */ }
  }
  return out;
}
const fbUri = (x: J) => typeof x === 'string' ? x : x?.uri || x?.url || '';
function fbScan(roots: J[]) {
  const vids = new Map<string, J>(), photos = new Map<string, J>(), groups: string[][] = [];
  let text = '', user = '', date = 0;
  const seen = new Set<J>();
  const visit = (o: J, grp: string[] | null) => {
    if (!o || typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    if (Array.isArray(o)) { for (const v of o) visit(v, grp); return; }
    const id = typeof o.id === 'string' ? o.id : '';
    const leg = o.videoDeliveryLegacyFields || (o.browser_native_hd_url || o.browser_native_sd_url ? o : null);
    const hd = leg?.browser_native_hd_url || o.playable_url_quality_hd, sd = leg?.browser_native_sd_url || o.playable_url;
    if (id && (hd || sd) && okUrl(hd || sd)) {
      const v = vids.get(id) || {};
      vids.set(id, { ...v, hd: v.hd || hd, sd: v.sd || sd });
    }
    if (id && (o.__typename === 'Video' || vids.has(id))) {
      const v = vids.get(id) || {};
      vids.set(id, {
        ...v, w: v.w || o.width || o.original_width || 0, h: v.h || o.height || o.original_height || 0,
        dur: v.dur || (o.playable_duration_in_ms ? o.playable_duration_in_ms / 1000 : o.length_in_second || 0),
        thumb: v.thumb || fbUri(o.preferred_thumbnail?.image) || fbUri(o.thumbnailImage) || '',
      });
    }
    if (id && o.__typename === 'Photo') {
      const u = fbUri(o.photo_image) || fbUri(o.image) || fbUri(o.viewer_image) || fbUri(o.large_share_image);
      const p = photos.get(id) || {};
      photos.set(id, { url: p.url || (okUrl(u) ? u : ''), w: p.w || o.viewer_image?.width || o.photo_image?.width || o.image?.width || 0, h: p.h || o.viewer_image?.height || o.photo_image?.height || o.image?.height || 0 });
    }
    if (grp && id && (o.__typename === 'Photo' || o.__typename === 'Video') && !grp.includes(id)) grp.push(id);
    if (!text && typeof o.message?.text === 'string' && o.message.text.trim()) text = o.message.text;
    if (!user && Array.isArray(o.actors) && o.actors[0]?.name) user = o.actors[0].name;
    if (!date && typeof o.creation_time === 'number') date = o.creation_time;
    for (const k in o) {
      const v = o[k];
      if (!v || typeof v !== 'object') continue;
      if (!grp && (k === 'attachments' || k === 'all_subattachments') && JSON.stringify(v).match(/"__typename":"(?:Photo|Video)"/)) { const g: string[] = []; groups.push(g); visit(v, g); }
      else visit(v, grp);
    }
  };
  for (const r of roots) visit(r, null);
  return { vids, photos, groups, text, user, date };
}
async function fb(url: string) {
  let u = url.replace(/^https:\/\/(?:m|web|mbasic|mobile|touch|business|free|lm|l)\.facebook\.com\//i, 'https://www.facebook.com/');
  const get = async (x: string) => {
    const r = await fetch(x, { headers: PAGE, redirect: 'follow', signal: AbortSignal.timeout(30000) });
    if (r.status === 429) throw new Err(429, 'Facebook sedang membatasi permintaan. Coba lagi beberapa menit lagi.');
    return { html: await r.text(), fin: r.url || x };
  };
  let { html, fin } = await get(u);
  const wall = () => /\/login|checkpoint/.test(new URL(fin).pathname);
  // photo.php / photo/?fbid= bounce to login for visitors, the same photo under /<page>/photos/<id>/ does not (any page name works)
  const pid = /[?&]fbid=(\d+)/.exec(u)?.[1] || /[?&]fbid%3D(\d+)/.exec(fin)?.[1];
  if (wall() && pid) ({ html, fin } = await get(`https://www.facebook.com/a/photos/${pid}/`));
  if (wall()) throw new Err(422, 'Postingan Facebook ini tidak publik (perlu login). Hanya video, reels, dan foto yang dibagikan ke Publik yang bisa diunduh.');
  const want = (s: string) => /[?&](?:v|video_id)=(\d+)/.exec(s)?.[1] || /\/(?:videos|reel|reels|watch)\/(?:[^/?#]+\/)?(\d{6,})/.exec(s)?.[1] || '';
  const vid = want(fin) || want(u), fbid = /[?&](?:fbid|story_fbid)=(\d+)/.exec(fin)?.[1] || /\/photos\/(?:[^/]+\/)?(\d{6,})/.exec(fin)?.[1] || '';
  const s = fbScan(fbBlocks(html));
  // the progressive "HD" file is at most 720p on its short side, whatever the source was
  const fit = (w: number, h: number) => { const k = w && h ? Math.min(1, 720 / Math.min(w, h)) : 1; return [Math.round(w * k / 2) * 2, Math.round(h * k / 2) * 2]; };
  const vItem = (id: string) => { const v = s.vids.get(id); if (!v || !(v.hd || v.sd)) return null; const [w, h] = fit(v.w || 0, v.h || 0); return { type: 'video', url: v.hd || v.sd, alt: v.hd && v.sd !== v.hd ? v.sd : undefined, thumb: v.thumb, w, h, dur: v.dur || 0, ext: 'mp4' }; };
  const pItem = (id: string) => { const p = s.photos.get(id); return p?.url ? { type: 'image', url: p.url, thumb: p.url, w: p.w || 0, h: p.h || 0, ext: 'jpg' } : null; };
  const one = (id: string) => vItem(id) || pItem(id);
  let items: J[] = [];
  if (vid && s.vids.has(vid)) items = [vItem(vid)];
  else if (fbid && s.photos.has(fbid)) items = [pItem(fbid)];
  if (!items.filter(Boolean).length) for (const g of s.groups) { items = g.map(one).filter(Boolean); if (items.length) break; }
  if (!items.length && s.vids.size) items = [vItem([...s.vids.keys()][0])];
  items = items.filter(Boolean);
  const meta = (p: string) => unent(new RegExp(`<meta[^>]+property="${p}"[^>]+content="([^"]*)"`).exec(html)?.[1] || '');
  if (!items.length) {
    const ov = meta('og:video:secure_url') || meta('og:video:url') || meta('og:video');
    const oi = meta('og:image');
    if (okUrl(ov)) items = [{ type: 'video', url: ov, thumb: okUrl(oi) ? oi : '', w: 0, h: 0, dur: 0, ext: 'mp4' }];
    else if (okUrl(oi) && !/\/(?:videos|reel|watch)\b|[?&]v=/.test(fin)) items = [{ type: 'image', url: oi, thumb: oi, w: 0, h: 0, ext: 'jpg' }];
  }
  const text = String(s.text || meta('og:description') || '').trim();
  if (!items.length && !text) {
    console.log('fb', fin, html.length, s.vids.size, s.photos.size, s.groups.length);
    throw new Err(422, 'Facebook tidak menampilkan isi postingan ini tanpa login. Pastikan postingannya Publik (ikon bola dunia), lalu salin ulang link-nya.');
  }
  const t = /<title>([^<]*)<\/title>/.exec(html)?.[1] || '';
  return {
    user: s.user || (unent(t).replace(/\s*[|\-]\s*Facebook\s*$/i, '').split(' | ')[0].slice(0, 60).replace(/^Facebook$/i, '')), fullname: s.user || '', text,
    date: s.date ? isoDate(s.date * 1000) : '', code: vid || fbid || (/\/(?:posts|share\/\w)\/([\w-]+)/.exec(fin)?.[1] || 'fb').slice(0, 40), avatar: '', items,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const q = new URL(req.url).searchParams, a = q.get('a'), u = q.get('u') || '';
  try {
    await guard(req.headers.get('x-amatu') || q.get('s') || '');
    if (a === 'ig') return out(await ig(q.get('code') || ''));
    if (a === 'fb') {
      if (!FBHOST.test(u)) throw new Err(422, 'Link Facebook tidak dikenali.');
      return out(await fb(u));
    }
    if (a === 'threads') {
      if (!/^https:\/\/(www\.)?threads\.(com|net)\//.test(u)) throw new Err(422, 'Link Threads tidak dikenali.');
      return out(await threads(u));
    }
    if (a === 'resolve') {
      const x = new URL(u);
      if (x.protocol !== 'https:' || !SHORT.test(x.hostname)) throw new Err(422, 'Link tidak dikenali.');
      const r = await fetch(u, { headers: PAGE, redirect: 'follow', signal: AbortSignal.timeout(15000) });
      r.body?.cancel();
      let fin = r.url || u;
      // a share link that bounced to a login page still names the post in ?next=
      try { const f = new URL(fin), nx = f.searchParams.get('next'); if (nx && /login|checkpoint/.test(f.pathname)) fin = new URL(nx, f.origin).href; } catch { /* as is */ }
      return out({ url: fin });
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
