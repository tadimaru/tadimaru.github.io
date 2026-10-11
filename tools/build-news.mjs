// しゃろ勉ニュースの Web 版を作る（2026-10-11。見た目は 2026-10-11 の方向 B「兄弟型」）。
//
//   node tools/build-news.mjs
//
// Supabase の news_articles を**公開鍵で**読み（RLS により「公開済み・公開日時を過ぎた」記事しか取れない）、
// sharoben-news/ を丸ごと作り直し、sitemap.xml を書き直す。GitHub Actions（.github/workflows/build-news.yml）が
// 毎朝 7:05 と手動で動かす。依存パッケージなし（Node 22 の fetch だけ）。
//
// 作るもの：
//   /sharoben-news/                      トップ（新着＋帯：今週の法改正・今月の統計・人事のしごと・勉強のこと）
//   /sharoben-news/<id>/                 記事（要点・本文・試験との関係・原典・共有・バナー・同じ種類の記事）
//   /sharoben-news/category/<slug>/      種類ごとの一覧
//   /sharoben-news/series/ と /series/<slug>/   連載（series が同じ記事）
//   /sharoben-news/digest/<yyyy-mm>/     その月の法改正のまとめ
//   /sharoben-news/about/                このサイトについて（運営者・編集方針・訂正）
//   /sharoben-news/feed.xml              RSS
//   /sitemap.xml
//
// ⚠️ 書き込める鍵（service_role / secret）は使わない・書かない。
// ⚠️ 読めなかったら何も書き換えずに失敗する（記事が0本と取り違えて全ページを消さないため）。
// 本文の書き方はアプリ（rom の lib/widgets/simple_markdown.dart）と管理ページのプレビューと同じ範囲だけ扱う。
// 関連：開発企画課/tickets/rom/open/2026-10-11-rom-news-web.md、マーケティング課/人事メディア/Web版の方向性_2026-10-11.md

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'sharoben-news');
const SITE = 'https://tadimaru.com';
const BASE = '/sharoben-news/';
const MEDIA = 'しゃろ勉ニュース';
const TAGLINE = 'はたらくルールの、いまを知る。';
const X_ACCOUNT = 'sharoshi_benkyo';
// ロゴ（元は マーケティング課/人事メディア/画像/ロゴ/ の 4088×800。余白を切って高さ96pxにしたもの）
const ASSETS = '/assets/sharoben-news/';

// アプリ・管理ページと同じプロジェクト・同じ公開鍵（読むだけの権限）
const SUPABASE_URL = 'https://xetnqhtacaefcgoijbwg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Qt4m9CQb0UZrUS3tZmVoxA_How-2PLU';
const COLUMNS = 'id,title,summary,body,category,image_url,link_url,link_label,source_name,is_pr,published_at';
// Web 版だけが使う列（supabase_news_web_fields.sql）。まだ無ければ無しで読む
const WEB_COLUMNS = 'points,exam_note,series';

// 種類 → URL の名前と色。決まった4つ以外は c-<番号>・灰色
const CATEGORIES = {
  学習: { slug: 'study', cls: 'study' },
  法改正: { slug: 'law', cls: 'law' },
  採用: { slug: 'hiring', cls: 'hire' },
  人事制度: { slug: 'hr', cls: 'hr' },
};

// 手で書いている URL（sitemap.xml をこのスクリプトが書き直すので、ここに持つ）
const STATIC_URLS = [
  ['/', 'monthly'],
  ['/privacy/', 'yearly'],
  ['/tokusho/', 'yearly'],
  ['/terms/', 'yearly'],
  ['/sharoushi/', 'monthly'],
  ['/sharoushi/terms/', 'yearly'],
];

const APP_STORE = 'https://apps.apple.com/jp/app/id6812129020';
const GOOGLE_PLAY = 'https://play.google.com/store/apps/details?id=com.tadimaru.rom';

// ── 流入元の印（2026-10-11 代表：ストアと社労士勉強くんのページへのリンクに付ける） ──
// サイトにアクセス解析は無い。数えるのはストアの統計：
//   Google Play … referrer に utm_* を入れる（Play Console の「獲得」で見える）
//   App Store  … ct（キャンペーン名）と pt（提供元の番号。App Store Connect のキャンペーンリンクから）
// 社労士勉強くんのページ（/sharoushi/）は、受け取った utm_* を自分のストアのボタンへ引き継ぐ（sharoushi/index.html）
export const UTM_SOURCE = 'sharoben-news';
export const APPLE_PROVIDER_TOKEN = '129435321';

export function playUrl(medium, content) {
  const referrer = new URLSearchParams({ utm_source: UTM_SOURCE, utm_medium: medium, utm_campaign: 'sharoben-news', ...(content ? { utm_content: content } : {}) });
  return `${GOOGLE_PLAY}&referrer=${encodeURIComponent(referrer.toString())}`;
}
export function appStoreUrl() {
  const q = new URLSearchParams({ ...(APPLE_PROVIDER_TOKEN ? { pt: APPLE_PROVIDER_TOKEN } : {}), ct: UTM_SOURCE, mt: '8' });
  return `${APP_STORE}?${q}`;
}
export function appPageUrl(medium, content) {
  const q = new URLSearchParams({ utm_source: UTM_SOURCE, utm_medium: medium, utm_campaign: 'sharoben-news', ...(content ? { utm_content: content } : {}) });
  return `/sharoushi/?${q}`;
}

// ── 読む ───────────────────────────────────
function fetchRows(columns) {
  const url = `${SUPABASE_URL}/rest/v1/news_articles?select=${columns}&order=published_at.desc&limit=1000`;
  return fetch(url, { headers: { apikey: SUPABASE_KEY }, signal: AbortSignal.timeout(30000) });
}

async function fetchArticles() {
  let res = await fetchRows(`${COLUMNS},${WEB_COLUMNS}`);
  if (res.status === 400) {
    console.warn('Web 版の列（points / exam_note / series）がまだ無いので、無しで読む');
    res = await fetchRows(COLUMNS);
  }
  if (!res.ok) throw new Error(`news_articles: HTTP ${res.status}`);
  const raw = await res.json();
  if (!Array.isArray(raw)) throw new Error('news_articles: 配列ではない');
  const articles = raw.filter((a) =>
    Number.isInteger(a.id) && typeof a.title === 'string' && a.title && typeof a.body === 'string' &&
    !isNaN(new Date(a.published_at)) && /^https:\/\//.test(a.image_url || ''));
  if (articles.length !== raw.length) console.warn(`形の合わない記事を ${raw.length - articles.length} 本とばした`);
  const now = Date.now();
  return articles
    .filter((a) => new Date(a.published_at).getTime() <= now)
    .map((a) => ({
      ...a,
      category: a.category || '学習',
      points: typeof a.points === 'string' ? a.points.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 3) : [],
      exam_note: typeof a.exam_note === 'string' ? a.exam_note.trim() : '',
      series: typeof a.series === 'string' ? a.series.trim() : '',
    }));
}

// ── 本文（アプリの SimpleMarkdown と同じ書き方だけ） ──
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 太字か、リンク（URL は括弧を1組まで含めてよい）。太字の中のリンクもリンクにする
const INLINE = /\*\*(.+?)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s()]+(?:\([^\s()]*\)[^\s()]*)*)\)/g;
function inline(text, rel) {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    out += esc(text.slice(last, m.index));
    if (m[1] !== undefined) out += '<strong>' + inline(m[1], rel) + '</strong>';
    else out += `<a href="${esc(m[3])}" target="_blank" rel="${rel}">${esc(m[2])}</a>`;
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

export function renderMarkdown(text, rel = 'noopener noreferrer') {
  const out = [];
  let para = [];
  let list = [];
  const flushPara = () => { if (para.length) { out.push('<p>' + para.map((t) => inline(t, rel)).join('<br>') + '</p>'); para = []; } };
  const flushList = () => { if (list.length) { out.push('<ul>' + list.map((t) => '<li>' + inline(t, rel) + '</li>').join('') + '</ul>'); list = []; } };
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    // 記事の見出しが h1 なので、本文の # は h2、## は h3 にする
    if (!line.trim()) { flushPara(); flushList(); }
    else if (line.startsWith('## ')) { flushPara(); flushList(); out.push('<h3>' + inline(line.slice(3), rel) + '</h3>'); }
    else if (line.startsWith('# ')) { flushPara(); flushList(); out.push('<h2>' + inline(line.slice(2), rel) + '</h2>'); }
    else if (line.startsWith('- ') || line.startsWith('・')) { flushPara(); list.push(line.startsWith('- ') ? line.slice(2) : line.slice(1)); }
    else { flushList(); para.push(line); }
  }
  flushPara(); flushList();
  return out.join('\n');
}

function plain(text) {
  return text.replace(INLINE, (m, bold, label) => bold ?? label).replace(/\s+/g, ' ').trim();
}

// 説明文：summary があればそれ。無ければ要点の1つ目、無ければ本文の最初の段落から記号を除いて約100字
export function describe(article, max = 100) {
  const base = (article.summary || '').trim() || (article.points && article.points[0]) || article.body
    .replace(/\r\n/g, '\n').split('\n')
    .filter((l) => l.trim() && !/^#{1,6}\s/.test(l) && !/^(-\s|・)/.test(l))
    .join('');
  const chars = [...plain(base)];
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join('');
}

// 本文に「訂正（YYYY-MM-DD）：」の行があれば、その日付（編集方針の「訂正」の書き方）
export function correctionDate(body) {
  const m = body.match(/^訂正[（(](\d{4}-\d{2}-\d{2})[）)]/m);
  return m ? m[1] : null;
}

// ── 日付（日本時間） ──────────────────────────────
function jst(iso) {
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}
const pad2 = (n) => String(n).padStart(2, '0');
const fmtDate = (iso) => { const t = jst(iso); return `${t.y}年${t.m}月${t.d}日`; };
const fmtShort = (iso) => { const t = jst(iso); return `${t.m}/${t.d}`; };
const isoDate = (iso) => { const t = jst(iso); return `${t.y}-${pad2(t.m)}-${pad2(t.d)}`; };
const monthKey = (iso) => { const t = jst(iso); return `${t.y}-${pad2(t.m)}`; };

// ── 種類・連載 ───────────────────────────────
function categoryList(articles) {
  const names = [...new Set(articles.map((a) => a.category))];
  const known = Object.keys(CATEGORIES).filter((n) => names.includes(n));
  const other = names.filter((n) => !(n in CATEGORIES)).sort();
  return [...known, ...other].map((name, i) => ({
    name,
    slug: CATEGORIES[name]?.slug ?? `c-${i + 1}`,
    cls: CATEGORIES[name]?.cls ?? 'other',
  }));
}
const catOf = (categories, a) => categories.find((c) => c.name === a.category);

// 連載の URL は名前のハッシュ（名前を変えなければ変わらない。日本語を URL に入れない）
const seriesSlug = (name) => 's-' + createHash('sha1').update(name).digest('hex').slice(0, 8);
function seriesList(articles) {
  const names = [...new Set(articles.map((a) => a.series).filter(Boolean))];
  return names.map((name) => ({ name, slug: seriesSlug(name), articles: articles.filter((a) => a.series === name) }));
}

// ── 見た目 ──────────────────────────────────
const STYLE = `
/* しゃろ勉ニュース（方向 B・兄弟型）。tools/build-news.mjs が書き出す。手で直さない */
:root{
  --navy:#1f4b8e;--navy-deep:#163a70;--ink:#17213a;--sub:#56627a;
  --paper:#ffffff;--wash:#f2f5fa;--line:#dce3ee;--chip:#dfe7f8;--marker:#ffe36e;
  --cat-study:#1f3f8f;--cat-study-bg:#e8eef9;--cat-law:#8f1f2f;--cat-law-bg:#f9e8ea;
  --cat-hire:#1f6f4f;--cat-hire-bg:#e8f5ee;--cat-hr:#5f3f8f;--cat-hr-bg:#efe8f9;--cat-other:#56627a;--cat-other-bg:#eef0f4;
  --display:"Zen Kaku Gothic New","Hiragino Sans","Yu Gothic UI","Yu Gothic",Meiryo,sans-serif;
  --body:"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI","Yu Gothic",Meiryo,sans-serif;
  --num:"Barlow","Segoe UI",system-ui,sans-serif;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --navy:#8fb0ea;--navy-deep:#1c3563;--ink:#e7ecf5;--sub:#a4b0c6;--paper:#111a2b;--wash:#0b1322;--line:#26344d;--chip:#233a63;--marker:rgba(255,215,80,.42);
  --cat-study:#9db8f0;--cat-study-bg:#1b2a4d;--cat-law:#f0a0ac;--cat-law-bg:#4a1f27;--cat-hire:#8fd4b0;--cat-hire-bg:#173a2b;--cat-hr:#c7aef0;--cat-hr-bg:#33244d;--cat-other:#a4b0c6;--cat-other-bg:#1b2436;
  color-scheme:dark}}
:root[data-theme="dark"]{
  --navy:#8fb0ea;--navy-deep:#1c3563;--ink:#e7ecf5;--sub:#a4b0c6;--paper:#111a2b;--wash:#0b1322;--line:#26344d;--chip:#233a63;--marker:rgba(255,215,80,.42);
  --cat-study:#9db8f0;--cat-study-bg:#1b2a4d;--cat-law:#f0a0ac;--cat-law-bg:#4a1f27;--cat-hire:#8fd4b0;--cat-hire-bg:#173a2b;--cat-hr:#c7aef0;--cat-hr-bg:#33244d;--cat-other:#a4b0c6;--cat-other-bg:#1b2436;
  color-scheme:dark}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--wash);color:var(--ink);font-family:var(--body);font-size:16px;line-height:1.85}
img{max-width:100%;height:auto;display:block}
a{color:var(--navy)}
a:focus-visible,button:focus-visible{outline:3px solid var(--marker);outline-offset:2px;border-radius:4px}
h1,h2,h3{font-family:var(--display);line-height:1.45;margin:0;text-wrap:balance}
.wrap{max-width:1080px;margin:0 auto;padding-inline:16px}
.narrow{max-width:760px}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
.site{background:var(--paper);border-bottom:1px solid var(--line)}
.site .top{display:flex;align-items:flex-end;gap:16px;padding-block:16px 8px;flex-wrap:wrap}
.brand{text-decoration:none;color:var(--ink);line-height:1.2;display:grid;gap:6px}
.brand img{height:30px;width:auto}
@media (min-width:600px){.brand img{height:36px}}
.brand .tagline{display:block;font-size:12px;color:var(--sub);letter-spacing:.06em;padding-left:2px}
.site .x{margin-left:auto;font-size:13px;color:var(--sub);text-decoration:none;display:flex;align-items:center;gap:6px}
.site .x svg{width:16px;height:16px;fill:currentColor}
.cats{display:flex;gap:4px;overflow-x:auto;padding-block:6px 0;scrollbar-width:none;margin-bottom:-1px}
.cats a{flex:0 0 auto;font-family:var(--display);font-weight:700;font-size:14px;text-decoration:none;color:var(--sub);padding:8px 12px;border-bottom:3px solid transparent}
.cats a[aria-current="page"]{color:var(--ink);border-color:var(--navy)}
.label{display:inline-block;font-family:var(--display);font-weight:700;font-size:11px;letter-spacing:.08em;padding:2px 8px;border-radius:4px;line-height:1.6;white-space:nowrap;text-decoration:none}
.label.law{color:var(--cat-law);background:var(--cat-law-bg)}.label.hr{color:var(--cat-hr);background:var(--cat-hr-bg)}
.label.hire{color:var(--cat-hire);background:var(--cat-hire-bg)}.label.study{color:var(--cat-study);background:var(--cat-study-bg)}.label.other{color:var(--cat-other);background:var(--cat-other-bg)}
.label.series{color:var(--navy);background:var(--chip)}
.meta{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;font-size:12px;color:var(--sub)}
.pr{border:1px solid currentColor;border-radius:3px;padding:0 4px;line-height:1.5;font-size:11px}
.card{display:block;background:var(--paper);border:1px solid var(--line);border-radius:12px;overflow:hidden;text-decoration:none;color:inherit;min-width:0}
.card:hover{border-color:var(--navy)}
.card .img{aspect-ratio:1200/630;background:var(--chip);overflow:hidden}
.card .img img{width:100%;height:100%;object-fit:cover}
.card .body{padding:12px 14px 14px;display:grid;gap:6px}
.card h3,.card h2{font-size:15px;font-weight:700}
.hero{display:grid;gap:14px;margin-top:18px}
@media (min-width:760px){.hero{grid-template-columns:3fr 2fr}.hero .side{display:grid;gap:14px;align-content:start}}
.hero .lead h2{font-size:22px;font-weight:900}
.hero .lead .body{padding:16px 18px 18px}
.hero .side .card{display:grid;grid-template-columns:120px 1fr}
.hero .side .card .img{aspect-ratio:1}
.hero .side .card .body{padding:10px 12px}
.hero .side .card h3{font-size:14px;line-height:1.5}
.band{margin-top:40px}
.band-head{display:flex;align-items:baseline;gap:14px;margin-bottom:12px;flex-wrap:wrap}
.band-head h2,.page-title{font-size:21px;font-weight:900;padding-left:12px;border-left:5px solid var(--navy)}
.band-head h2.law,.page-title.law{border-color:var(--cat-law)}.band-head h2.hr,.page-title.hr{border-color:var(--cat-hr)}
.band-head h2.hire,.page-title.hire{border-color:var(--cat-hire)}.band-head h2.study,.page-title.study{border-color:var(--cat-study)}
.band-head .desc{font-size:13px;color:var(--sub)}
.band-head .more{margin-left:auto;font-size:13px;font-weight:700;text-decoration:none;white-space:nowrap}
.page-title{margin-top:24px}
.page-desc{font-size:14px;color:var(--sub);margin:8px 0 0 17px}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));margin-top:14px}
.band .grid{margin-top:0}
.list{display:grid;background:var(--paper);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.list a{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center;padding:12px 16px;text-decoration:none;color:inherit;border-top:1px solid var(--line);min-width:0}
.list a:first-child{border-top:0}
.list a:hover{background:var(--wash)}
.list .t{font-family:var(--display);font-weight:700;font-size:15px;line-height:1.5;display:flex;gap:10px;align-items:center;flex-wrap:wrap;min-width:0}
.list time{font-family:var(--num);font-size:13px;color:var(--sub);font-variant-numeric:tabular-nums;white-space:nowrap}
.series-grid{display:grid;gap:14px}
@media (min-width:760px){.series-grid{grid-template-columns:1fr 1fr 1fr}}
.digest{background:#163a70;color:#fff;border-radius:12px;padding:22px 22px 20px;display:grid;gap:10px;grid-template-columns:1fr auto;align-items:center;margin-top:14px}
.digest h3{font-size:19px;font-weight:900;color:#fff}
.digest p{margin:0;font-size:14px;color:#c9d6ee;line-height:1.7}
.digest a{color:#fff;font-weight:700;font-size:14px;white-space:nowrap;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.35);border-radius:8px;padding:8px 14px;text-decoration:none}
@media (max-width:600px){.digest{grid-template-columns:1fr}}
.btn{font-family:var(--display);font-weight:700;font-size:13px;text-decoration:none;border-radius:8px;padding:7px 14px;border:1px solid var(--line);color:var(--ink);background:var(--paper);cursor:pointer}
.btn.primary{background:var(--navy);border-color:var(--navy);color:var(--paper)}
.banner{text-decoration:none;position:relative;display:grid;grid-template-columns:1fr auto;gap:0 20px;align-items:end;background:linear-gradient(135deg,#163a70,#1f4b8e 70%,#2d62b3);color:#fff;border-radius:14px;overflow:hidden;padding:22px 0 0 22px;min-height:190px;margin-top:14px}
.banner .text{display:grid;gap:10px;padding-bottom:22px;min-width:0;align-self:center}
.banner .tag{justify-self:start;font-size:10px;letter-spacing:.08em;color:#c9d6ee;border:1px solid rgba(255,255,255,.35);border-radius:3px;padding:0 6px;line-height:1.7}
.banner .app{display:flex;align-items:center;gap:10px}
.banner .app img{width:44px;height:44px;border-radius:11px;box-shadow:0 4px 12px rgba(0,0,0,.25)}
.banner .app .nm{font-family:var(--display);font-weight:900;font-size:17px;line-height:1.2;color:#fff}
.banner .app .nm small{display:block;font-weight:500;font-size:11px;color:#c9d6ee;letter-spacing:.06em;margin-top:3px}
.banner h3{font-family:var(--display);font-weight:900;font-size:22px;line-height:1.4;color:#fff}
.banner h3 mark{background:none;color:#ffe36e;padding:0;display:inline-block}
.banner p{margin:0;font-size:13.5px;line-height:1.75;color:#dbe4f5}
.banner .stores{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:4px}
.banner .stores img{height:40px;width:auto}
.banner .shot{align-self:end;width:150px;margin-right:22px;border-radius:14px 14px 0 0;box-shadow:0 -6px 24px rgba(0,0,0,.3);display:block}
@media (max-width:640px){.banner{grid-template-columns:1fr;padding:20px 18px 0}.banner .text{padding-bottom:18px}.banner .shot{justify-self:center;width:170px;margin-right:0}}
.banner.compact{min-height:0}
.banner.compact h3{font-size:18px}
.banner.compact .shot{width:120px}
footer{margin-top:40px;background:var(--paper);border-top:1px solid var(--line);padding-block:24px 40px;font-size:13px;color:var(--sub)}
footer p{margin:0 0 6px;line-height:1.7}
footer .links{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:10px}
footer a{color:var(--sub)}
.crumb{font-size:13px;color:var(--sub);margin-top:16px}
.crumb a{text-decoration:none}
article{background:var(--paper);border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-top:12px}
article .img{aspect-ratio:1200/630;background:var(--chip)}
article .img img{width:100%;height:100%;object-fit:cover}
article .content{padding:20px 20px 28px}
@media (min-width:600px){article .content{padding:26px 32px 34px}}
article h1{font-size:25px;font-weight:900;line-height:1.5;margin-top:10px}
@media (min-width:600px){article h1{font-size:29px}}
.notice{margin-top:14px;background:var(--cat-law-bg);color:var(--cat-law);border-radius:8px;padding:8px 12px;font-size:13px}
.points{margin-top:20px;background:var(--wash);border-radius:10px;padding:14px 18px 14px 16px;border-left:4px solid var(--navy)}
.points .ttl{font-family:var(--display);font-weight:700;font-size:13px;letter-spacing:.08em;color:var(--navy)}
.points ol{margin:6px 0 0;padding-left:1.3em;font-size:15px;line-height:1.75}
.points li+li{margin-top:4px}
.md{font-size:17px;line-height:1.95;margin-top:8px;overflow-wrap:anywhere}
.md h2{font-size:20px;font-weight:700;margin:32px 0 8px;padding-bottom:6px;border-bottom:2px solid var(--line)}
.md h2::before{content:"";display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--navy);margin-right:10px;vertical-align:.2em}
.md h3{font-size:18px;font-weight:700;margin:26px 0 6px}
.md p{margin:14px 0}
.md ul{padding-left:1.3em;margin:12px 0}
.md li{margin:4px 0}
.md strong{background:linear-gradient(transparent 62%,var(--marker) 62%,var(--marker) 92%,transparent 92%)}
.exam{margin-top:30px;border:1.5px solid var(--navy);border-radius:12px;padding:16px 18px;display:grid;gap:8px;background:var(--paper)}
.exam .ttl{font-family:var(--display);font-weight:900;font-size:15px;color:var(--navy)}
.exam p{margin:0;font-size:15px;line-height:1.8}
.exam .btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
.linkbtn{display:block;text-align:center;border:1px solid var(--line);border-radius:10px;padding:12px;margin-top:26px;text-decoration:none;font-weight:700;font-family:var(--display)}
.linkbtn:hover{border-color:var(--navy)}
.share{margin-top:28px;border-top:1px dashed var(--line);padding-top:18px;display:grid;gap:12px}
.share .row{display:flex;gap:8px;flex-wrap:wrap}
.share .row .btn{display:inline-flex;align-items:center;gap:6px}
.share .row .btn svg{width:15px;height:15px;fill:currentColor}
.memo{background:var(--wash);border-radius:10px;padding:12px 14px;display:grid;gap:8px}
.memo .ttl{font-family:var(--display);font-weight:700;font-size:13px;color:var(--sub);letter-spacing:.06em}
.memo pre{margin:0;font:inherit;font-size:13.5px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--ink)}
.memo .copy{justify-self:start}
.status{font-size:12px;color:var(--sub);min-height:1.2em}
.related{margin-top:28px}
.related h2{font-size:17px;font-weight:900;margin-bottom:10px}
.back{display:inline-block;margin-top:22px;font-size:14px;font-weight:700;text-decoration:none}
.prose{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:22px 22px 26px;margin-top:14px;font-size:15px;line-height:1.9}
.prose h2{font-size:17px;font-weight:900;margin:22px 0 6px}
.prose h2:first-child{margin-top:0}
.prose ul{padding-left:1.3em;margin:6px 0}
.prose p{margin:8px 0}
.empty{color:var(--sub);padding:24px 0}
`;

const X_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.9 2H22l-7.4 8.5L23 22h-6.8l-5.3-6.9L4.8 22H1.7l7.9-9.1L1 2h7l4.8 6.3L18.9 2Zm-1.2 18h1.9L7.1 3.9H5.1L17.7 20Z"/></svg>';

function header(categories, current) {
  const link = (href, label, on) => `<a href="${href}"${on ? ' aria-current="page"' : ''}>${esc(label)}</a>`;
  return `<header class="site"><div class="wrap">
<div class="top"><a class="brand" href="${BASE}"><picture><source srcset="${ASSETS}logo-white.png" media="(prefers-color-scheme: dark)"><img src="${ASSETS}logo.png" alt="${MEDIA}" width="331" height="36"></picture><span class="tagline">${TAGLINE}</span></a>
<a class="x" href="https://x.com/${X_ACCOUNT}" target="_blank" rel="noopener">${X_SVG}@${X_ACCOUNT}</a></div>
<nav class="cats" aria-label="種類">${link(BASE, 'すべて', current === 'all')}${categories.map((c) => link(`${BASE}category/${c.slug}/`, c.name, current === c.slug)).join('')}${link(`${BASE}series/`, '連載', current === 'series')}</nav>
</div></header>`;
}

function footer() {
  return `<footer><div class="wrap">
<p>運営：<a href="/">合同会社たでぃまる</a></p>
<p>記事に誤りがあることが分かった場合は、速やかに修正し、必要に応じて記事内にその旨を記載します。</p>
<div class="links"><a href="${BASE}">記事の一覧</a><a href="${BASE}series/">連載</a><a href="${BASE}about/">このサイトについて</a><a href="${esc(appPageUrl('footer'))}">アプリ「社労士勉強くん」</a><a href="/privacy/">プライバシーポリシー</a><a href="${BASE}feed.xml">RSS</a></div>
</div></footer>`;
}

function page({ title, description, path, image, type = 'website', body, jsonLd, categories, current = 'all', script = '' }) {
  const url = SITE + path;
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="${type}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
${image ? `<meta property="og:image" content="${esc(image)}">\n<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">\n` : ''}<meta property="og:site_name" content="${MEDIA}">
<meta property="og:locale" content="ja_JP">
<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
<meta name="twitter:site" content="@${X_ACCOUNT}">
<meta name="theme-color" content="#1f4b8e">
<link rel="alternate" type="application/rss+xml" title="${MEDIA}" href="${BASE}feed.xml">
<link rel="icon" type="image/png" href="${ASSETS}symbol.png">
<link rel="apple-touch-icon" href="${ASSETS}symbol.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Zen+Kaku+Gothic+New:wght@500;700;900&family=Barlow:wght@600;700&display=swap">
<link rel="stylesheet" href="${BASE}style.css">
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>\n` : ''}</head>
<body>
${header(categories, current)}
${body}
${footer()}
${script}</body>
</html>
`;
}

function meta(a, categories, { series = true } = {}) {
  const cat = catOf(categories, a);
  const s = series && a.series ? `<a class="label series" href="${BASE}series/${seriesSlug(a.series)}/">連載・${esc(a.series)}</a>` : '';
  return `<div class="meta"><span class="label ${cat?.cls ?? 'other'}">${esc(a.category)}</span>${s}${a.is_pr ? '<span class="pr">PR</span>' : ''}<time datetime="${isoDate(a.published_at)}">${fmtDate(a.published_at)}</time></div>`;
}

function card(a, categories, { heading = 'h3', cls = 'card' } = {}) {
  return `<a class="${cls}" href="${BASE}${a.id}/"><div class="img"><img src="${esc(a.image_url)}" alt="" width="1200" height="630" loading="lazy"></div><div class="body"><${heading}>${esc(a.title)}</${heading}>${meta(a, categories, { series: false })}</div></a>`;
}

function listRows(list, categories) {
  return `<div class="list">${list.map((a) => {
    const cat = catOf(categories, a);
    return `<a href="${BASE}${a.id}/"><span class="t"><span class="label ${cat?.cls ?? 'other'}">${esc(a.category)}</span>${esc(a.title)}</span><time datetime="${isoDate(a.published_at)}">${fmtShort(a.published_at)}</time></a>`;
  }).join('')}</div>`;
}

// アプリのバナー（2026-10-11 代表：自然な広告っぽく。「当社のアプリ」と明記して広告であることを隠さない）
function banner(compact, medium, content) {
  const shot = compact ? '/sharoushi/img/02_level.jpg' : '/sharoushi/img/01_home.jpg';
  const h3 = compact ? '読んだ論点を、<mark>その場で10問。</mark>' : 'いまの実力、<mark>科目ごとに数字で。</mark>';
  const p = compact
    ? '7科目・約6,900問。最初のレベル判定で、科目ごとの現在地が分かります。'
    : '最初のレベル判定で現在地が分かり、10問解くたびにスコアとランクが動きます。7科目・約6,900問。登録・ログインは要りません。';
  return `<a class="banner${compact ? ' compact' : ''}" href="${esc(appPageUrl(medium, content))}" aria-label="社労士勉強くん アプリの紹介">
<div class="text"><span class="tag">当社のアプリ</span>
<div class="app"><img src="/sharoushi/img/icon.png" alt="" width="44" height="44"><div class="nm">社労士勉強くん<small>iPhone・Android　無料で1日20問・登録不要</small></div></div>
<h3>${h3}</h3><p>${p}</p>
<div class="stores"><img src="/assets/badges/app-store-ja.svg" alt="App Store" width="120" height="40"><img src="/assets/badges/google-play-ja.png" alt="Google Play" width="135" height="40"></div></div>
<img class="shot" src="${shot}" alt="" width="338" height="720" loading="lazy">
</a>`;
}

// ── トップ ──────────────────────────────────
function topPage(articles, categories) {
  const hero = articles.slice(0, 4);
  const law = articles.filter((a) => a.category === '法改正').slice(0, 5);
  const withSeries = articles.filter((a) => a.series).slice(0, 3);
  const hr = articles.filter((a) => a.category === '人事制度' || a.category === '採用').slice(0, 4);
  const study = articles.filter((a) => a.category === '学習').slice(0, 4);
  const sections = [];

  if (hero.length) {
    sections.push(`<section class="hero" aria-label="新着">
${card(hero[0], categories, { heading: 'h2', cls: 'card lead' })}
${hero.length > 1 ? `<div class="side">${hero.slice(1).map((a) => card(a, categories)).join('\n')}</div>` : ''}
</section>`);
  }
  if (law.length) {
    const key = monthKey(law[0].published_at);
    const [y, m] = key.split('-');
    sections.push(`<section class="band">
<div class="band-head"><h2 class="law">今週の法改正</h2><span class="desc">いつから・誰が・何をするか。施行日は原典で確かめています</span><a class="more" href="${BASE}category/law/">法改正の記事をすべて →</a></div>
${listRows(law, categories)}
<div class="digest"><div><h3>まとめ：${Number(m)}月の法改正（${y}年）</h3><p>この月に出した法改正の記事を1か所に。記事が出るたびに足していきます。</p></div><a href="${BASE}digest/${key}/">まとめを読む →</a></div>
</section>`);
  }
  if (withSeries.length) {
    sections.push(`<section class="band">
<div class="band-head"><h2 class="hr">今月の統計</h2><span class="desc">連載。毎月同じ見出しで積み、前月と比べられるように</span><a class="more" href="${BASE}series/">連載の一覧 →</a></div>
<div class="series-grid">${withSeries.map((a) => card(a, categories)).join('\n')}</div>
</section>`);
  }
  if (hr.length) {
    sections.push(`<section class="band">
<div class="band-head"><h2 class="hr">人事のしごと</h2><span class="desc">制度・採用・人的資本。現場の話が、そのまま試験の論点につながります</span><a class="more" href="${BASE}category/${hr[0].category === '採用' ? 'hiring' : 'hr'}/">人事制度・採用の記事 →</a></div>
<div class="grid">${hr.map((a) => card(a, categories)).join('\n')}</div>
</section>`);
  }
  sections.push(`<section class="band">
${study.length ? `<div class="band-head"><h2 class="study">勉強のこと</h2><span class="desc">続け方・年間の組み立て・出題の重さ。筆者の体験は一人称で</span><a class="more" href="${BASE}category/study/">学習の記事 →</a></div>
<div class="grid">${study.map((a) => card(a, categories)).join('\n')}</div>` : ''}
${banner(false, 'top')}
</section>`);
  if (!articles.length) sections.unshift('<p class="empty">記事を準備しています。</p>');

  return page({
    title: `${MEDIA}｜社労士試験の勉強と、人事・労務の話題`,
    description: `社労士試験の勉強のしかたや、法改正・採用・人事制度など人事と労務の話題を届ける${MEDIA}。運営は合同会社たでぃまる。`,
    path: BASE, image: articles[0]?.image_url, categories, current: 'all',
    body: `<main class="wrap">\n${sections.join('\n')}\n</main>`,
  });
}

// ── 一覧（種類・連載・まとめ） ──────────────────────
function listPage({ title, heading, description, path, list, categories, current, cls = '', intro = '' }) {
  return page({
    title, description, path, image: list[0]?.image_url, categories, current,
    body: `<main class="wrap">
<h1 class="page-title ${cls}">${esc(heading)}</h1>${intro ? `<p class="page-desc">${esc(intro)}</p>` : ''}
${list.length ? `<div class="grid">${list.map((a) => card(a, categories)).join('\n')}</div>` : '<p class="empty">記事を準備しています。</p>'}
${banner(true, 'list', current)}
</main>`,
  });
}

function seriesIndexPage(series, categories) {
  const body = `<main class="wrap">
<h1 class="page-title">連載</h1><p class="page-desc">毎月・毎回、同じ見出しで積んでいく記事です。</p>
${series.length ? `<div class="list" style="margin-top:14px">${series.map((s) => `<a href="${BASE}series/${s.slug}/"><span class="t">${esc(s.name)}</span><time>${s.articles.length}本</time></a>`).join('')}</div>` : '<p class="empty">連載を準備しています。</p>'}
</main>`;
  return page({ title: `連載｜${MEDIA}`, description: `${MEDIA}の連載の一覧。`, path: `${BASE}series/`, categories, current: 'series', body });
}

// ── 記事 ───────────────────────────────────
function shareBlock(a) {
  const url = `${SITE}${BASE}${a.id}/`;
  const x = `https://twitter.com/intent/tweet?${new URLSearchParams({ text: `${a.title}｜${MEDIA}`, url })}`;
  const line = `https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(url)}`;
  const memo = `【${a.category}】${a.title}${a.points[0] ? `\n${a.points[0]}` : ''}\n${url}`;
  return `<div class="share">
<div class="row"><a class="btn" href="${esc(x)}" target="_blank" rel="noopener">${X_SVG}X で共有</a><a class="btn" href="${esc(line)}" target="_blank" rel="noopener">LINE で送る</a><button type="button" class="btn" data-copy="${esc(url)}">リンクをコピー</button></div>
<div class="memo"><div class="ttl">社内で共有するときのひとこと（コピーして Slack やメールに）</div><pre id="memoText">${esc(memo)}</pre><button type="button" class="btn primary copy" data-copy-from="memoText">この文をコピー</button><div class="status" id="copyStatus" aria-live="polite"></div></div>
</div>`;
}

const SHARE_SCRIPT = `<script>
(function(){var st=document.getElementById('copyStatus');function done(){st.textContent='コピーしました';setTimeout(function(){st.textContent='';},2000);}function fail(){st.textContent='コピーできませんでした。文を選んでコピーしてください';}
document.querySelectorAll('[data-copy],[data-copy-from]').forEach(function(b){b.addEventListener('click',function(){var t=b.getAttribute('data-copy')||document.getElementById(b.getAttribute('data-copy-from')).textContent;try{navigator.clipboard.writeText(t).then(done,fail);}catch(e){fail();}});});})();
</script>
`;

function articlePage(a, articles, categories) {
  const path = `${BASE}${a.id}/`;
  const cat = catOf(categories, a);
  const rel = a.is_pr ? 'sponsored noopener noreferrer' : 'noopener noreferrer';
  const link = a.link_url && /^https?:\/\//.test(a.link_url)
    ? `<a class="linkbtn" href="${esc(a.link_url)}" target="_blank" rel="${rel}">${esc(a.link_label || 'くわしく見る')} ↗</a>`
    : '';
  const corrected = correctionDate(a.body);
  const related = (a.series
    ? articles.filter((b) => b.series === a.series && b.id !== a.id)
    : articles.filter((b) => b.category === a.category && b.id !== a.id)).slice(0, 3);
  const relatedTitle = a.series ? `連載「${a.series}」の記事` : `${a.category}の記事`;
  const body = `<main class="wrap narrow">
<div class="crumb"><a href="${BASE}">${MEDIA}</a> › <a href="${BASE}category/${cat?.slug ?? ''}/">${esc(a.category)}</a></div>
<article>
<div class="img"><img src="${esc(a.image_url)}" alt="" width="1200" height="630"></div>
<div class="content">
${meta(a, categories)}
<h1>${esc(a.title)}</h1>
${corrected ? `<div class="notice">この記事は ${corrected.replace(/-/g, '/')} に訂正しました。本文の最後に訂正の内容があります。</div>` : ''}
${a.points.length ? `<div class="points"><div class="ttl">要点</div><ol>${a.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ol></div>` : ''}
<div class="md">
${renderMarkdown(a.body, rel)}
</div>
${a.exam_note ? `<div class="exam"><div class="ttl">試験との関係</div><p>${esc(a.exam_note)}</p><div class="btns"><a class="btn" href="${esc(appPageUrl('exam', String(a.id)))}">アプリ「社労士勉強くん」とは</a></div></div>` : ''}
${link}
${shareBlock(a)}
</div>
</article>
${banner(true, 'article', String(a.id))}
${related.length ? `<section class="related"><h2>${esc(relatedTitle)}</h2>${listRows(related, categories)}</section>` : ''}
<a class="back" href="${BASE}">← 記事の一覧へ</a>
</main>`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: a.title,
    image: [a.image_url],
    datePublished: new Date(a.published_at).toISOString(),
    author: { '@type': 'Organization', name: '合同会社たでぃまる', url: SITE + '/' },
    publisher: { '@type': 'Organization', name: '合同会社たでぃまる', url: SITE + '/', logo: { '@type': 'ImageObject', url: `${SITE}${ASSETS}logo.png` } },
    mainEntityOfPage: SITE + path,
  };
  return page({ title: `${a.title}｜${MEDIA}`, description: describe(a), path, image: a.image_url, type: 'article', body, jsonLd, categories, current: cat?.slug, script: SHARE_SCRIPT });
}

// ── このサイトについて（2026-10-11 代表：トップには置かず、フッターから） ─────
function aboutPage(categories) {
  const body = `<main class="wrap narrow">
<h1 class="page-title">このサイトについて</h1>
<div class="prose">
<h2>何を届けるか</h2>
<p>${MEDIA}は、社労士試験の勉強をしている人と、人事・労務・採用の仕事をしている人に向けて、法改正・統計・人事の制度・勉強のしかたを短い記事で届けます。1本の記事は1つのテーマだけを扱い、5分ほどで読める長さにしています。</p>
<h2>書くときの決まり</h2>
<ul>
<li>法令・統計の記事は、e-Gov 法令検索・官報・各省の公表資料など<strong>原典で確かめてから</strong>出します。原典で確かめられないことは書きません。</li>
<li>数字は、出典名・調査名・年を本文に書きます。図表やグラフは転載せず、数字と結論だけを必要な範囲で引きます。</li>
<li>記事は AI の支援を受けて作成し、法令・統計は原典と照合したうえで、当社が確認して公開しています。</li>
<li>試験問題の本文は、要約や言い換えであっても載せません。</li>
<li>個人や特定の企業を悪く書くことはしません。</li>
<li>対価をいただいて掲載する記事には「PR」と表示します。</li>
</ul>
<h2>訂正について</h2>
<p>記事に誤りがあることが分かった場合は、速やかに修正し、必要に応じて記事内にその旨（訂正した日付と内容）を記載します。</p>
<h2>運営者</h2>
<p>合同会社たでぃまる（<a href="/">会社のサイト</a>）。社労士試験の学習アプリ「<a href="${esc(appPageUrl('about'))}">社労士勉強くん</a>」を作っています。記事の下にあるアプリの案内は、当社自身の広告です。</p>
<p>このサイトはアクセス解析を使っておらず、Cookie も使いません。詳しくは<a href="/privacy/">プライバシーポリシー</a>をご覧ください。</p>
<h2>連絡先</h2>
<p>記事の誤りや、取り上げてほしい話題は、X の <a href="https://x.com/${X_ACCOUNT}" target="_blank" rel="noopener">@${X_ACCOUNT}</a> か、会社のサイトの連絡先までお知らせください。</p>
</div>
</main>`;
  return page({ title: `このサイトについて｜${MEDIA}`, description: `${MEDIA}の運営者、記事を書くときの決まり、訂正の方針。`, path: `${BASE}about/`, categories, current: 'about', body });
}

// ── RSS・sitemap ───────────────────────────────
function rss(articles) {
  const items = articles.slice(0, 30).map((a) => `  <item>
    <title>${esc(a.title)}</title>
    <link>${SITE}${BASE}${a.id}/</link>
    <guid isPermaLink="true">${SITE}${BASE}${a.id}/</guid>
    <pubDate>${new Date(a.published_at).toUTCString()}</pubDate>
    <category>${esc(a.category)}</category>
    <description>${esc(describe(a, 200))}</description>
  </item>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>${MEDIA}</title>
  <link>${SITE}${BASE}</link>
  <description>${TAGLINE} 社労士試験の勉強と、人事・労務の話題。</description>
  <language>ja</language>
  <atom:link href="${SITE}${BASE}feed.xml" rel="self" type="application/rss+xml"/>
${items}
</channel>
</rss>
`;
}

function sitemap(articles, categories, series, digests) {
  const latest = articles[0] ? isoDate(articles[0].published_at) : null;
  const url = (loc, extra = '') => `  <url><loc>${esc(SITE + loc)}</loc>${extra}</url>`;
  const lines = [
    ...STATIC_URLS.map(([loc, freq]) => url(loc, `<changefreq>${freq}</changefreq>`)),
    url(BASE, `${latest ? `<lastmod>${latest}</lastmod>` : ''}<changefreq>daily</changefreq>`),
    url(`${BASE}about/`, '<changefreq>monthly</changefreq>'),
    url(`${BASE}series/`, '<changefreq>weekly</changefreq>'),
    ...categories.map((c) => {
      const first = articles.find((a) => a.category === c.name);
      return url(`${BASE}category/${c.slug}/`, `<lastmod>${isoDate(first.published_at)}</lastmod><changefreq>weekly</changefreq>`);
    }),
    ...series.map((s) => url(`${BASE}series/${s.slug}/`, `<lastmod>${isoDate(s.articles[0].published_at)}</lastmod><changefreq>weekly</changefreq>`)),
    ...digests.map((d) => url(`${BASE}digest/${d.key}/`, `<lastmod>${isoDate(d.articles[0].published_at)}</lastmod>`)),
    ...articles.map((a) => url(`${BASE}${a.id}/`, `<lastmod>${isoDate(a.published_at)}</lastmod>`)),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${lines.join('\n')}\n</urlset>\n`;
}

// ── 書く ───────────────────────────────────
async function write(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function main() {
  const articles = await fetchArticles();

  // 0本：前回は記事があったのに0本なら、設定の崩れを疑って止める（ALLOW_EMPTY=1 で通す）
  if (articles.length === 0 && existsSync(OUT)) {
    const before = (await readdir(OUT)).filter((n) => /^\d+$/.test(n)).length;
    if (before > 0 && process.env.ALLOW_EMPTY !== '1') {
      throw new Error(`記事が0本しか取れなかった（前回は ${before} 本）。全部を消してよいときだけ ALLOW_EMPTY=1 で動かす`);
    }
  }

  const categories = categoryList(articles);
  const series = seriesList(articles);
  const digestKeys = [...new Set(articles.filter((a) => a.category === '法改正').map((a) => monthKey(a.published_at)))];
  const digests = digestKeys.map((key) => ({ key, articles: articles.filter((a) => a.category === '法改正' && monthKey(a.published_at) === key) }));

  await rm(OUT, { recursive: true, force: true });
  await write(join(OUT, 'style.css'), STYLE.trimStart());
  await write(join(OUT, 'index.html'), topPage(articles, categories));
  await write(join(OUT, 'about', 'index.html'), aboutPage(categories));
  await write(join(OUT, 'series', 'index.html'), seriesIndexPage(series, categories));
  await write(join(OUT, 'feed.xml'), rss(articles));
  for (const c of categories) {
    await write(join(OUT, 'category', c.slug, 'index.html'), listPage({
      title: `${c.name}の記事｜${MEDIA}`, heading: c.name, description: `${MEDIA}の「${c.name}」の記事の一覧です。`,
      path: `${BASE}category/${c.slug}/`, list: articles.filter((a) => a.category === c.name), categories, current: c.slug, cls: c.cls,
    }));
  }
  for (const s of series) {
    await write(join(OUT, 'series', s.slug, 'index.html'), listPage({
      title: `連載「${s.name}」｜${MEDIA}`, heading: s.name, description: `${MEDIA}の連載「${s.name}」の記事の一覧です。`,
      path: `${BASE}series/${s.slug}/`, list: s.articles, categories, current: 'series',
      intro: '毎回、同じ見出しで積んでいる連載です。新しい順に並んでいます。',
    }));
  }
  for (const d of digests) {
    const [y, m] = d.key.split('-');
    await write(join(OUT, 'digest', d.key, 'index.html'), listPage({
      title: `まとめ：${Number(m)}月の法改正（${y}年）｜${MEDIA}`, heading: `まとめ：${Number(m)}月の法改正（${y}年）`,
      description: `${y}年${Number(m)}月に${MEDIA}で出した法改正の記事のまとめ。`,
      path: `${BASE}digest/${d.key}/`, list: d.articles, categories, current: 'law', cls: 'law',
      intro: 'この月に出した法改正の記事です。施行日と対象は、それぞれの記事と原典で確かめてください。',
    }));
  }
  for (const a of articles) {
    await write(join(OUT, String(a.id), 'index.html'), articlePage(a, articles, categories));
  }
  await write(join(ROOT, 'sitemap.xml'), sitemap(articles, categories, series, digests));
  console.log(`記事 ${articles.length} 本・種類 ${categories.length}・連載 ${series.length}・まとめ ${digests.length} を書き出した`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
