// しゃろ勉ニュースの Web 版を作る（2026-10-11。見た目は 2026-10-30 のデザイン案 A3「手帳と雑誌・明朝＋アプリ」）。
// 見本：マーケティング課/人事メディア/デザイン案_2026-10-30/案A3_手帳と雑誌_明朝＋アプリ/、比較.md の「A3」節
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
// 記事以外のページ（一覧・種類・連載・このサイトについて）でリンクを貼ったときの画像。記事は記事の写真（2026-10-24 代表）
const SITE_IMAGE = `${SITE}/assets/sharoben-news/ogp.png`;
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
  ['/news/2026-10-22-php/', 'yearly'],
  ['/privacy/', 'yearly'],
  ['/tokusho/', 'yearly'],
  ['/terms/', 'yearly'],
  ['/sharoushi/', 'monthly'],
  ['/sharoushi/terms/', 'yearly'],
  ['/drive/', 'monthly'],
  ['/drive/manual/', 'monthly'],
  ['/drive/contact/', 'yearly'],
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
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
const fmtDay = (iso) => { const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000); return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日（${WEEK[d.getUTCDay()]}）`; };
const fmtDot = (iso) => { const t = jst(iso); return `${t.y}.${pad2(t.m)}.${pad2(t.d)}`; };
// ヘッダーの「◯月◯日 更新」。いちばん新しい記事の公開日（ビルドした日ではない＝記事が増えない日はページが変わらない）
let UPDATED = '';

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
/* しゃろ勉ニュース（2026-10-30 デザイン案 A3「手帳と雑誌・明朝＋アプリ」）。tools/build-news.mjs が書き出す。手で直さない */
:root{
  --paper:#f6f2ec;--sheet:#fffdf9;--ink:#2f2a2b;--sub:#776d69;--line:#e4dbd0;--rule:#2f2a2b;
  --rose:#a8646b;--rose-soft:#f2e1de;--sage:#56715f;--sage-soft:#e3ebe2;--on-sage:#ffffff;--note:#fbf6e9;--tape:rgba(168,100,107,.28);
  --cat-law:#a8646b;--cat-law-bg:#f2e1de;--cat-hire:#56715f;--cat-hire-bg:#e3ebe2;
  --cat-hr:#7d6383;--cat-hr-bg:#ece3ee;--cat-study:#4e6886;--cat-study-bg:#e2e9f1;--cat-other:#776d69;--cat-other-bg:#ece7e1;
  --serif:"Shippori Mincho","Hiragino Mincho ProN","Yu Mincho",serif;
  --label:"Zen Kaku Gothic New","Hiragino Sans","Yu Gothic UI","Yu Gothic",Meiryo,sans-serif;
  --body:"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI","Yu Gothic",Meiryo,sans-serif;
  --hand:"Klee One","Zen Kaku Gothic New",sans-serif;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --paper:#1b1817;--sheet:#242020;--ink:#ece6e1;--sub:#b3a9a4;--line:#3b3532;--rule:#8a807b;
  --rose:#e0a3a9;--rose-soft:#46302f;--sage:#a9c4b0;--sage-soft:#2a372e;--on-sage:#1b1817;--note:#332e24;--tape:rgba(224,163,169,.3);
  --cat-law:#e0a3a9;--cat-law-bg:#46302f;--cat-hire:#a9c4b0;--cat-hire-bg:#2a372e;
  --cat-hr:#cdb3d3;--cat-hr-bg:#3a2f3e;--cat-study:#a9bfdb;--cat-study-bg:#28323f;--cat-other:#b3a9a4;--cat-other-bg:#2e2a28;
  color-scheme:dark}}
:root[data-theme="dark"]{
  --paper:#1b1817;--sheet:#242020;--ink:#ece6e1;--sub:#b3a9a4;--line:#3b3532;--rule:#8a807b;
  --rose:#e0a3a9;--rose-soft:#46302f;--sage:#a9c4b0;--sage-soft:#2a372e;--on-sage:#1b1817;--note:#332e24;--tape:rgba(224,163,169,.3);
  --cat-law:#e0a3a9;--cat-law-bg:#46302f;--cat-hire:#a9c4b0;--cat-hire-bg:#2a372e;
  --cat-hr:#cdb3d3;--cat-hr-bg:#3a2f3e;--cat-study:#a9bfdb;--cat-study-bg:#28323f;--cat-other:#b3a9a4;--cat-other-bg:#2e2a28;
  color-scheme:dark}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--body);font-size:16px;line-height:1.9}
img{max-width:100%;height:auto;display:block}
a{color:inherit}
a:focus-visible,button:focus-visible{outline:3px solid var(--rose);outline-offset:2px;border-radius:4px}
h1,h2,h3{font-family:var(--serif);font-weight:700;line-height:1.5;margin:0;text-wrap:pretty;letter-spacing:.02em}
.wrap{max-width:1040px;margin:0 auto;padding-inline:16px}
.narrow{max-width:720px}
main>*,.cover>*,.grid>*,.side>*,.series-grid>*{min-width:0}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}

/* ヘッダー：雑誌の表紙のように中央に */
.site{padding-top:20px;text-align:center}
.site .wrap{position:relative}
.site .date{font-family:var(--label);font-size:12px;color:var(--sub);letter-spacing:.12em}
.brand{display:inline-block;margin-top:8px;text-decoration:none}
.brand img{height:28px;width:auto;margin:0 auto}
@media (min-width:600px){.brand img{height:34px}}
.tagline{display:block;font-family:var(--serif);font-size:14px;color:var(--sub);margin-top:8px;letter-spacing:.14em}
.site .x{position:absolute;top:0;right:16px;color:var(--sub);text-decoration:none;font-family:var(--label);font-size:12px;display:flex;align-items:center;gap:6px}
.site .x svg{width:15px;height:15px;fill:currentColor}
@media (max-width:599px){.site .x span{display:none}}
.cats{display:flex;justify-content:center;gap:2px;margin-top:16px;border-top:1px solid var(--rule);border-bottom:1px solid var(--line);overflow-x:auto;scrollbar-width:none}
.cats a{flex:0 0 auto;text-decoration:none;font-family:var(--label);font-weight:500;font-size:14px;color:var(--sub);padding:11px 14px;letter-spacing:.08em}
.cats a[aria-current="page"]{color:var(--ink);font-weight:700;box-shadow:inset 0 -2px 0 var(--rose)}
@media (max-width:560px){.cats{justify-content:flex-start}}

.label{display:inline-block;font-family:var(--label);font-weight:700;font-size:11px;letter-spacing:.1em;padding:1px 9px;border-radius:999px;line-height:1.8;white-space:nowrap;text-decoration:none}
.label.law{color:var(--cat-law);background:var(--cat-law-bg)}.label.hire{color:var(--cat-hire);background:var(--cat-hire-bg)}
.label.hr{color:var(--cat-hr);background:var(--cat-hr-bg)}.label.study{color:var(--cat-study);background:var(--cat-study-bg)}
.label.other{color:var(--cat-other);background:var(--cat-other-bg)}
.label.series{color:var(--sage);background:transparent;border:1px solid var(--sage);padding:0 8px}
.meta{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;font-size:12px;color:var(--sub)}
.meta time{font-family:var(--label);letter-spacing:.06em}
.pr{border:1px solid currentColor;border-radius:3px;padding:0 4px;line-height:1.5;font-size:11px}

/* 記事のカード：枠なし・写真と文字 */
.card{display:grid;gap:10px;align-content:start;text-decoration:none;color:inherit}
.card .img{aspect-ratio:1200/630;border-radius:4px;overflow:hidden;background:var(--line)}
.card .img img{width:100%;height:100%;object-fit:cover;transition:transform .4s}
.card:hover .img img{transform:scale(1.03)}
.card .body{display:grid;gap:6px;align-content:start}
.card h2,.card h3{font-size:17px;line-height:1.6}
.card .excerpt{margin:0;color:var(--sub);font-size:15px;line-height:1.9}

/* 巻頭：大きな写真＋「新しい記事」 */
.cover{display:grid;gap:28px;margin-top:28px}
@media (min-width:820px){.cover{grid-template-columns:1.55fr 1fr;align-items:start}}
.cover .lead{gap:14px}
.cover .lead h2{font-size:24px;line-height:1.55}
@media (min-width:600px){.cover .lead h2{font-size:28px}}
.side-ttl{font-family:var(--hand);font-size:15px;color:var(--rose);margin:0 0 6px}
.side .card{grid-template-columns:120px 1fr;gap:14px;padding:14px 0;border-top:1px solid var(--line)}
.side .card:last-child{border-bottom:1px solid var(--line)}
.side .card h3{font-size:15.5px}

/* 帯（特集の見出し） */
.band{margin-top:56px}
.band-head{text-align:center;margin-bottom:22px}
.band-head .kicker{display:block;font-family:var(--hand);font-size:15px;color:var(--rose)}
.band-head h2{font-size:24px;margin-top:2px}
.band-head .desc{display:block;font-size:13px;color:var(--sub);margin-top:6px}
.band-head .orn{display:block;width:44px;height:1px;background:var(--rule);margin:14px auto 0}
.band.sage .kicker{color:var(--sage)}
.more{display:block;text-align:center;margin-top:18px;font-family:var(--label);font-size:13px;color:var(--rose);text-decoration:none;letter-spacing:.06em}

/* 目次のような番号つき一覧 */
.toc{background:var(--sheet);border-radius:6px;padding:4px 22px;border:1px solid var(--line)}
.toc a{display:grid;grid-template-columns:auto 1fr;gap:6px 18px;align-items:baseline;padding:16px 0;text-decoration:none;border-top:1px dashed var(--line)}
.toc a:first-child{border-top:0}
.toc .no{font-family:var(--serif);font-size:24px;color:var(--rose);line-height:1;grid-row:span 2;font-variant-numeric:tabular-nums}
.toc .t{font-family:var(--serif);font-weight:700;font-size:16px;line-height:1.6}
.toc time{font-family:var(--label);font-size:12px;color:var(--sub);letter-spacing:.06em}

/* 罫線の一覧（連載の一覧） */
.list{display:grid;background:var(--sheet);border:1px solid var(--line);border-radius:6px;padding:0 20px}
.list a{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center;padding:14px 0;text-decoration:none;border-top:1px dashed var(--line);min-width:0}
.list a:first-child{border-top:0}
.list .t{font-family:var(--serif);font-weight:700;font-size:16px;line-height:1.6;display:flex;gap:10px;align-items:center;flex-wrap:wrap;min-width:0}
.list time{font-family:var(--label);font-size:12px;color:var(--sub);white-space:nowrap}

.digest{margin-top:18px;background:var(--rose-soft);border-radius:6px;padding:20px 22px;display:grid;gap:4px 16px;grid-template-columns:1fr auto;align-items:center}
.digest .k{font-family:var(--hand);color:var(--rose);font-size:14px}
.digest h3{font-size:18px}
.digest a{font-family:var(--label);font-weight:700;font-size:13px;text-decoration:none;color:var(--rose);border:1px solid var(--rose);border-radius:999px;padding:7px 16px;white-space:nowrap;grid-row:span 2}
@media (max-width:520px){.digest{grid-template-columns:1fr}.digest a{grid-row:auto;justify-self:start;margin-top:8px}}

.grid,.series-grid{display:grid;gap:30px 22px;grid-template-columns:1fr}
@media (min-width:640px){.grid,.series-grid{grid-template-columns:repeat(3,1fr)}}
@media (max-width:639px){.grid .card,.series-grid .card{grid-template-columns:132px 1fr;gap:14px}.grid .card h3,.series-grid .card h3{font-size:15.5px}}

/* アプリの案内（当社の広告）：ここだけゴシックにして、記事と見分けがつくようにする */
.ad{display:grid;gap:0 20px;margin-top:56px;background:var(--sage-soft);border-radius:8px;overflow:hidden;text-decoration:none;color:var(--ink);padding:24px 22px 0;font-family:var(--label)}
@media (min-width:640px){.ad{grid-template-columns:1fr 170px;padding:30px 0 0 30px}}
.ad .tag{justify-self:start;font-size:11px;letter-spacing:.1em;color:var(--sage);border:1px solid var(--sage);border-radius:999px;padding:0 10px;line-height:1.8}
.ad .text{display:grid;gap:0;align-content:start;min-width:0}
.ad .nm{display:flex;align-items:center;gap:12px;margin-top:12px;font-weight:700;font-size:17px;line-height:1.3}
.ad .nm img{width:52px;height:52px;border-radius:13px;box-shadow:0 2px 8px rgba(47,42,43,.12)}
.ad .nm small{display:block;font-weight:500;font-size:11.5px;color:var(--sub);margin-top:3px}
.ad h3{font-family:var(--label);font-weight:700;letter-spacing:0;font-size:22px;margin-top:14px;line-height:1.45}
.ad h3 mark{background:none;color:var(--rose);padding:0}
.ad p{margin:6px 0 0;font-size:13.5px;color:var(--sub);line-height:1.8}
.ad .cta{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:16px 0 24px}
.ad .go{display:inline-block;background:var(--sage);color:var(--on-sage);font-weight:700;font-size:14px;border-radius:999px;padding:10px 22px}
.ad .stores{display:flex;gap:8px;align-items:center}
.ad .stores img{height:34px;width:auto}
.ad .shot{align-self:end;justify-self:center;width:150px;border-radius:16px 16px 0 0;box-shadow:0 -4px 18px rgba(47,42,43,.14)}
.ad.compact{margin-top:40px}

footer{margin-top:64px;border-top:1px solid var(--rule);padding:26px 0 44px;font-size:13px;color:var(--sub);text-align:center}
footer p{margin:0 0 6px;line-height:1.7}
footer .links{display:flex;flex-wrap:wrap;justify-content:center;gap:6px 18px;margin-top:10px}
footer a{color:var(--sub)}

/* 種類・連載・まとめの一覧 */
.page-title{margin-top:30px;text-align:center;font-size:26px}
.page-title::before{content:"";display:block;width:10px;height:10px;border-radius:50%;background:var(--rose);margin:0 auto 10px}
.page-title.law::before{background:var(--cat-law)}.page-title.hr::before{background:var(--cat-hr)}
.page-title.hire::before{background:var(--cat-hire)}.page-title.study::before{background:var(--cat-study)}
.page-desc{font-size:14px;color:var(--sub);margin:10px auto 0;text-align:center;max-width:640px}
.page-title+.grid,.page-desc+.grid{margin-top:32px}
.empty{color:var(--sub);padding:24px 0;text-align:center}

/* 記事ページ */
.crumb{font-family:var(--label);font-size:12px;color:var(--sub);margin-top:18px;letter-spacing:.04em}
.crumb a{text-decoration:none}
.head{text-align:center;margin-top:26px}
.head .meta{justify-content:center}
.head h1{font-size:25px;line-height:1.6;margin-top:12px}
@media (min-width:600px){.head h1{font-size:31px}}
.hero{margin:24px -16px 0;aspect-ratio:1200/630;overflow:hidden;background:var(--line)}
@media (min-width:752px){.hero{margin-inline:0;border-radius:4px}}
.hero img{width:100%;height:100%;object-fit:cover}
article.sheet{background:var(--sheet);border:1px solid var(--line);border-radius:6px;margin-top:-1px;padding:26px 20px 34px}
@media (min-width:600px){article.sheet{padding:34px 40px 42px}}
.notice{margin-bottom:18px;background:var(--rose-soft);color:var(--rose);border-radius:6px;padding:8px 12px;font-size:13px}
.points{background:var(--sage-soft);border-radius:6px;padding:16px 20px 12px;margin-bottom:22px}
.points .ttl{font-family:var(--hand);font-size:16px;color:var(--sage)}
.points ol{list-style:none;margin:6px 0 0;padding:0;background:repeating-linear-gradient(transparent 0 31px,var(--line) 31px 32px);line-height:32px}
.points li{padding-left:22px;position:relative;font-size:15px}
.points li::before{content:"";position:absolute;left:4px;top:12px;width:8px;height:8px;border-radius:50%;background:var(--sage)}
.md{font-size:17px;line-height:2;overflow-wrap:anywhere}
.md>:first-child{margin-top:0}
.md h2,.md h3{font-size:21px;margin:42px 0 12px;padding-bottom:10px;border-bottom:1px solid var(--line);position:relative}
.md h2::after,.md h3::after{content:"";position:absolute;left:0;bottom:-1px;width:48px;height:1px;background:var(--rose)}
.md h2{font-size:23px}
.md p{margin:16px 0}
.md ul{padding-left:1.2em;margin:14px 0}
.md li{margin:8px 0}
.md li::marker{color:var(--rose)}
.md strong{font-weight:700;background:linear-gradient(transparent 64%,var(--rose-soft) 64%)}
.md a{color:var(--rose)}
.exam{margin-top:38px;background:var(--note);border-radius:2px;padding:22px 20px 18px;position:relative;box-shadow:0 1px 0 var(--line)}
.exam::before{content:"";position:absolute;top:-9px;left:50%;width:84px;height:18px;margin-left:-42px;background:var(--tape);transform:rotate(-2deg)}
.exam .ttl{font-family:var(--hand);font-size:17px;color:var(--rose)}
.exam p{margin:6px 0 0;font-size:15px;line-height:1.9}
.exam .btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.linkbtn{display:block;text-align:center;border:1px solid var(--rule);border-radius:999px;padding:12px 16px;margin-top:30px;text-decoration:none;font-family:var(--label);font-weight:700;font-size:14px}
.linkbtn:hover{background:var(--ink);color:var(--sheet)}
.share{margin-top:30px;border-top:1px solid var(--line);padding-top:20px;display:grid;gap:14px}
.share .row{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}
.btn{font-family:var(--label);font-weight:700;font-size:13px;text-decoration:none;border-radius:999px;padding:8px 16px;border:1px solid var(--line);background:var(--sheet);color:var(--ink);cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.btn svg{width:14px;height:14px;fill:currentColor}
.btn.primary{background:var(--sage);border-color:var(--sage);color:var(--on-sage)}
.memo{background:var(--paper);border-radius:6px;padding:14px 16px;display:grid;gap:8px}
.memo .ttl{font-family:var(--hand);font-size:14px;color:var(--sub)}
.memo pre{margin:0;font:inherit;font-size:13.5px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--ink)}
.memo .copy{justify-self:start}
.status{font-size:12px;color:var(--sub);min-height:1.2em}
.related{margin-top:48px}
.related .k{display:block;text-align:center;font-family:var(--hand);color:var(--rose);font-size:15px}
.related h2{text-align:center;font-size:20px;margin-bottom:16px}
.back{display:block;text-align:center;margin-top:26px;font-family:var(--label);font-size:14px;color:var(--rose);text-decoration:none}

/* このサイトについて */
.prose{background:var(--sheet);border:1px solid var(--line);border-radius:6px;padding:24px 22px 28px;margin-top:24px;font-size:15.5px;line-height:1.95}
.prose h2{font-size:19px;margin:26px 0 6px}
.prose h2:first-child{margin-top:0}
.prose ul{padding-left:1.3em;margin:6px 0}
.prose p{margin:8px 0}
.prose a{color:var(--rose)}
`;

const X_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.9 2H22l-7.4 8.5L23 22h-6.8l-5.3-6.9L4.8 22H1.7l7.9-9.1L1 2h7l4.8 6.3L18.9 2Zm-1.2 18h1.9L7.1 3.9H5.1L17.7 20Z"/></svg>';

function header(categories, current) {
  const link = (href, label, on) => `<a href="${href}"${on ? ' aria-current="page"' : ''}>${esc(label)}</a>`;
  return `<header class="site"><div class="wrap">
${UPDATED ? `<div class="date">${UPDATED} 更新</div>\n` : ''}<a class="brand" href="${BASE}"><picture><source srcset="${ASSETS}logo-white.png" media="(prefers-color-scheme: dark)"><img src="${ASSETS}logo.png" alt="${MEDIA}" width="331" height="36"></picture></a>
<span class="tagline">${TAGLINE}</span>
<a class="x" href="https://x.com/${X_ACCOUNT}" target="_blank" rel="noopener" aria-label="X @${X_ACCOUNT}">${X_SVG}<span>@${X_ACCOUNT}</span></a>
<nav class="cats" aria-label="種類">${link(BASE, 'すべて', current === 'all')}${categories.map((c) => link(`${BASE}category/${c.slug}/`, c.name, current === c.slug)).join('')}${link(`${BASE}series/`, '連載', current === 'series')}</nav>
</div></header>`;
}

function footer() {
  return `<footer><div class="wrap">
<p>運営：<a href="/">合同会社たでぃまる</a></p>
<div class="links"><a href="${BASE}">記事の一覧</a><a href="${BASE}series/">連載</a><a href="${BASE}about/">このサイトについて</a><a href="${esc(appPageUrl('footer'))}">アプリ「社労士勉強くん」</a><a href="/privacy/">プライバシーポリシー</a><a href="${BASE}feed.xml">RSS</a></div>
</div></footer>`;
}

function page({ title, description, path, image = SITE_IMAGE, type = 'website', body, jsonLd, categories, current = 'all', script = '' }) {
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
<meta name="theme-color" content="#f6f2ec" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#1b1817" media="(prefers-color-scheme: dark)">
<link rel="alternate" type="application/rss+xml" title="${MEDIA}" href="${BASE}feed.xml">
<link rel="icon" type="image/png" href="${ASSETS}symbol.png">
<link rel="apple-touch-icon" href="${ASSETS}symbol.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Shippori+Mincho:wght@600;700&family=Zen+Kaku+Gothic+New:wght@500;700&family=Klee+One:wght@600&display=swap">
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

function card(a, categories, { heading = 'h3', cls = 'card', excerpt = false } = {}) {
  return `<a class="${cls}" href="${BASE}${a.id}/"><div class="img"><img src="${esc(a.image_url)}" alt="" width="1200" height="630" loading="lazy"></div><div class="body">${meta(a, categories, { series: false })}<${heading}>${esc(a.title)}</${heading}>${excerpt ? `<p class="excerpt">${esc(describe(a, 120))}</p>` : ''}</div></a>`;
}

// 目次のような番号つき一覧（法改正の帯・記事の下の「ほかの記事」）
function tocRows(list) {
  return `<div class="toc">${list.map((a, i) => `<a href="${BASE}${a.id}/"><span class="no">${pad2(i + 1)}</span><span class="t">${esc(a.title)}</span><time datetime="${isoDate(a.published_at)}">${fmtDot(a.published_at)}</time></a>`).join('')}</div>`;
}

function listRows(list, categories) {
  return `<div class="list">${list.map((a) => {
    const cat = catOf(categories, a);
    return `<a href="${BASE}${a.id}/"><span class="t"><span class="label ${cat?.cls ?? 'other'}">${esc(a.category)}</span>${esc(a.title)}</span><time datetime="${isoDate(a.published_at)}">${fmtShort(a.published_at)}</time></a>`;
  }).join('')}</div>`;
}

// アプリのバナー（2026-10-11 代表：自然な広告っぽく。「当社のアプリ」と明記して広告であることを隠さない）
// 2026-10-30 デザイン案 A3：紙面は明朝、この案内だけゴシックにして宣伝だと分かるように。文言・画像・リンク先は前のまま
function banner(compact, medium, content) {
  const shot = compact ? '/sharoushi/img/02_level.jpg' : '/sharoushi/img/01_home.jpg';
  const h3 = compact ? 'すきま時間に、<mark>10問ずつ。</mark>' : 'いまの実力、<mark>科目ごとに数字で。</mark>';
  const p = compact
    ? '7科目・約6,900問。最初のレベル判定で、科目ごとの現在地が分かります。'
    : '最初のレベル判定で現在地が分かり、10問解くたびにスコアとランクが動きます。7科目・約6,900問。登録・ログインは要りません。';
  return `<a class="ad${compact ? ' compact' : ''}" href="${esc(appPageUrl(medium, content))}" aria-label="社労士勉強くん アプリの紹介">
<div class="text"><span class="tag">当社のアプリ</span>
<div class="nm"><img src="/sharoushi/img/icon.png" alt="" width="52" height="52"><div>社労士勉強くん<small>iPhone・Android　無料で1日20問・登録不要</small></div></div>
<h3>${h3}</h3><p>${p}</p>
<div class="cta"><span class="go">アプリを見る</span><span class="stores"><img src="/assets/badges/app-store-ja.svg" alt="App Store" width="102" height="34"><img src="/assets/badges/google-play-ja.png" alt="Google Play" width="115" height="34"></span></div></div>
<img class="shot" src="${shot}" alt="" width="338" height="720" loading="lazy">
</a>`;
}

// ── トップ ──────────────────────────────────
function topPage(articles, categories) {
  const hero = articles.slice(0, 4);
  const law = articles.filter((a) => a.category === '法改正').slice(0, 5);
  const withSeries = articles.filter((a) => a.series).slice(0, 3);
  const hr = articles.filter((a) => a.category === '人事制度' || a.category === '採用').slice(0, 3);
  const study = articles.filter((a) => a.category === '学習').slice(0, 3);
  const sections = [];
  const head = (kicker, title, desc) => `<div class="band-head"><span class="kicker">${kicker}</span><h2>${title}</h2><span class="desc">${desc}</span><span class="orn"></span></div>`;

  if (hero.length) {
    sections.push(`<section class="cover" aria-label="新着">
${card(hero[0], categories, { heading: 'h2', cls: 'card lead', excerpt: true })}
${hero.length > 1 ? `<div class="side"><p class="side-ttl">新しい記事</p>${hero.slice(1).map((a) => card(a, categories)).join('\n')}</div>` : ''}
</section>`);
  }
  if (law.length) {
    const key = monthKey(law[0].published_at);
    const [y, m] = key.split('-');
    sections.push(`<section class="band">
${head('いつから、だれが、なにを', '法改正', 'いつから、誰を対象に、何が変わるのかを解説します')}
${tocRows(law)}
<div class="digest"><span class="k">今月のまとめ</span><a href="${BASE}digest/${key}/">まとめを読む →</a><h3>${y}年${Number(m)}月の法改正記事まとめ</h3></div>
<a class="more" href="${BASE}category/law/">法改正の記事をすべて →</a>
</section>`);
  }
  if (withSeries.length) {
    sections.push(`<section class="band sage">
${head('毎月、同じ形で', '統計の連載', '毎月の統計を同じ形で追い、前の月と比べながら読めます')}
<div class="series-grid">${withSeries.map((a) => card(a, categories)).join('\n')}</div>
<a class="more" href="${BASE}series/">連載の一覧 →</a>
</section>`);
  }
  if (hr.length) {
    sections.push(`<section class="band sage">
${head('現場で役立つ', '人事のしごと', '採用・制度・人的資本など、人事の仕事にかかわる話題です')}
<div class="grid">${hr.map((a) => card(a, categories)).join('\n')}</div>
<a class="more" href="${BASE}category/${hr[0].category === '採用' ? 'hiring' : 'hr'}/">人事制度・採用の記事 →</a>
</section>`);
  }
  sections.push(`<section class="band">
${study.length ? `${head('働きながら、続ける', '勉強のこと', '続け方や1年の組み立てなど、社労士試験の効果的な勉強法についてです')}
<div class="grid">${study.map((a) => card(a, categories)).join('\n')}</div>
<a class="more" href="${BASE}category/study/">学習の記事 →</a>` : ''}
${banner(false, 'top')}
</section>`);
  if (!articles.length) sections.unshift('<p class="empty">記事を準備しています。</p>');

  return page({
    title: `${MEDIA}｜社労士試験の勉強と、人事・労務の話題`,
    description: `社労士試験の勉強のしかたや、法改正・採用・人事制度など人事と労務の話題を届ける${MEDIA}。運営は合同会社たでぃまる。`,
    path: BASE, categories, current: 'all',
    body: `<main class="wrap">\n${sections.join('\n')}\n</main>`,
  });
}

// ── 一覧（種類・連載・まとめ） ──────────────────────
function listPage({ title, heading, description, path, list, categories, current, cls = '', intro = '' }) {
  return page({
    title, description, path, categories, current,
    body: `<main class="wrap">
<h1 class="page-title ${cls}">${esc(heading)}</h1>${intro ? `<p class="page-desc">${esc(intro)}</p>` : ''}
${list.length ? `<div class="grid">${list.map((a) => card(a, categories)).join('\n')}</div>` : '<p class="empty">記事を準備しています。</p>'}
${banner(true, 'list', current)}
</main>`,
  });
}

function seriesIndexPage(series, categories) {
  const body = `<main class="wrap">
<h1 class="page-title">連載</h1><p class="page-desc">毎月の統計など、決まったテーマで続けている記事です。</p>
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
<div class="memo"><div class="ttl">社内に共有するときの文面（Slack やメールに貼れます）</div><pre id="memoText">${esc(memo)}</pre><button type="button" class="btn primary copy" data-copy-from="memoText">この文をコピー</button><div class="status" id="copyStatus" aria-live="polite"></div></div>
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
  const relatedTitle = a.series ? `連載「${a.series}」のほかの記事` : `ほかの${a.category}の記事`;
  const body = `<main class="wrap narrow">
<div class="crumb"><a href="${BASE}">${MEDIA}</a> › <a href="${BASE}category/${cat?.slug ?? ''}/">${esc(a.category)}</a></div>
<div class="head">
${meta(a, categories)}
<h1>${esc(a.title)}</h1>
</div>
<div class="hero"><img src="${esc(a.image_url)}" alt="" width="1200" height="630"></div>
<article class="sheet">
${corrected ? `<div class="notice">この記事は ${corrected.replace(/-/g, '/')} に訂正しました。本文の最後に訂正の内容があります。</div>` : ''}
${a.points.length ? `<div class="points"><div class="ttl">この記事のポイント</div><ol>${a.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ol></div>` : ''}
<div class="md">
${renderMarkdown(a.body, rel)}
</div>
${a.exam_note ? `<div class="exam"><div class="ttl">試験との関係</div><p>${esc(a.exam_note)}</p><div class="btns"><a class="btn" href="${esc(appPageUrl('exam', String(a.id)))}">アプリ「社労士勉強くん」とは</a></div></div>` : ''}
${link}
${shareBlock(a)}
</article>
${banner(true, 'article', String(a.id))}
${related.length ? `<section class="related"><span class="k">あわせて読みたい</span><h2>${esc(relatedTitle)}</h2>${tocRows(related)}</section>` : ''}
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
<h2>記事の作り方</h2>
<p>記事は AI の支援を受けて作成し、法令・統計は原典と照合したうえで、当社が確認して公開しています。</p>
<h2>訂正について</h2>
<p>記事は、e-Gov 法令検索・官報・各省の公表資料など原典で確かめて公開するよう努めておりますが、万が一、記事に誤りがあることが分かった場合は、以下の連絡先までお知らせください。速やかに修正し、必要に応じて記事内にその旨（訂正した日付と内容）を記載します。</p>
<h2>連絡先</h2>
<p>記事の誤りや、取り上げてほしい話題は、X の <a href="https://x.com/${X_ACCOUNT}" target="_blank" rel="noopener">@${X_ACCOUNT}</a> か、会社のサイトの連絡先までお知らせください。</p>
<h2>運営者</h2>
<p>合同会社たでぃまる（<a href="/">会社のサイト</a>）。社労士試験の学習アプリ「<a href="${esc(appPageUrl('about'))}">社労士勉強くん</a>」を作っています。記事の下にあるアプリの案内は、当社自身の広告です。</p>
<p>このサイトはアクセス解析を使っておらず、Cookie も使いません。詳しくは<a href="/privacy/">プライバシーポリシー</a>をご覧ください。</p>
</div>
</main>`;
  return page({ title: `このサイトについて｜${MEDIA}`, description: `${MEDIA}の記事の作り方、訂正の方針、連絡先、運営者。`, path: `${BASE}about/`, categories, current: 'about', body });
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

  UPDATED = articles[0] ? fmtDay(articles[0].published_at) : '';
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
      intro: '決まったテーマで続けている連載です。新しい記事から並んでいます。',
    }));
  }
  for (const d of digests) {
    const [y, m] = d.key.split('-');
    await write(join(OUT, 'digest', d.key, 'index.html'), listPage({
      title: `${y}年${Number(m)}月の法改正記事まとめ｜${MEDIA}`, heading: `${y}年${Number(m)}月の法改正記事まとめ`,
      description: `${y}年${Number(m)}月に${MEDIA}で公開した法改正の記事のまとめです。`,
      path: `${BASE}digest/${d.key}/`, list: d.articles, categories, current: 'law', cls: 'law',
      intro: 'この月に公開した法改正の記事です。制度のくわしい内容は、各記事の出典（官公庁の資料）もあわせてご確認ください。',
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
