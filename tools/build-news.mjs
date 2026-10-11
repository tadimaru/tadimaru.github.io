// しゃろ勉ニュースの Web 版を作る（2026-10-11）。
//
//   node tools/build-news.mjs
//
// Supabase の news_articles を**公開鍵で**読み（RLS により「公開済み・公開日時を過ぎた」記事しか取れない）、
// sharoben-news/ を丸ごと作り直し、sitemap.xml を書き直す。GitHub Actions（.github/workflows/build-news.yml）が
// 毎朝 7:05 と手動で動かす。依存パッケージなし（Node 22 の fetch だけ）。
//
// ⚠️ 書き込める鍵（service_role / secret）は使わない・書かない。
// ⚠️ 読めなかったら何も書き換えずに失敗する（記事が0本と取り違えて全ページを消さないため）。
// 本文の書き方はアプリ（rom の lib/widgets/simple_markdown.dart）と管理ページのプレビューと同じ範囲だけ扱う。
// 関連：開発企画課/tickets/rom/open/2026-10-11-rom-news-web.md

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'sharoben-news');
const SITE = 'https://tadimaru.com';
const BASE = '/sharoben-news/';
const MEDIA = 'しゃろ勉ニュース';

// アプリ・管理ページと同じプロジェクト・同じ公開鍵（読むだけの権限）
const SUPABASE_URL = 'https://xetnqhtacaefcgoijbwg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Qt4m9CQb0UZrUS3tZmVoxA_How-2PLU';
const COLUMNS = 'id,title,summary,body,category,image_url,link_url,link_label,source_name,is_pr,published_at';

// 種類 → URL の名前。決まった4つ以外は c-<番号> にする（日本語を URL に入れない）
const CATEGORY_SLUGS = { 学習: 'study', 法改正: 'law', 採用: 'hiring', 人事制度: 'hr' };

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

// ── 読む ───────────────────────────────────
async function fetchArticles() {
  const url = `${SUPABASE_URL}/rest/v1/news_articles?select=${COLUMNS}&order=published_at.desc&limit=1000`;
  const res = await fetch(url, { headers: { apikey: SUPABASE_KEY }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`news_articles: HTTP ${res.status}`);
  const raw = await res.json();
  if (!Array.isArray(raw)) throw new Error('news_articles: 配列ではない');
  const articles = raw.filter((a) =>
    Number.isInteger(a.id) && typeof a.title === 'string' && a.title && typeof a.body === 'string' &&
    !isNaN(new Date(a.published_at)) && /^https:\/\//.test(a.image_url || ''));
  if (articles.length !== raw.length) console.warn(`形の合わない記事を ${raw.length - articles.length} 本とばした`);
  // RLS が守るはずだが、念のため公開日時を過ぎたものだけ
  const now = Date.now();
  return articles.filter((a) => new Date(a.published_at).getTime() <= now);
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

// 説明文：summary があればそれ。無ければ本文の最初の段落から記号を除いて約100字
export function describe(article, max = 100) {
  const base = (article.summary || '').trim() || article.body
    .replace(/\r\n/g, '\n').split('\n')
    .filter((l) => l.trim() && !/^#{1,6}\s/.test(l) && !/^(-\s|・)/.test(l))
    .join('');
  const plain = base.replace(INLINE, (m, bold, label) => bold ?? label).replace(/\s+/g, ' ').trim();
  const chars = [...plain];
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : plain;
}

// ── 日付（日本時間） ──────────────────────────────
function jst(iso) {
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}
const fmtDate = (iso) => { const t = jst(iso); return `${t.y}年${t.m}月${t.d}日`; };
const isoDate = (iso) => { const t = jst(iso); return `${t.y}-${String(t.m).padStart(2, '0')}-${String(t.d).padStart(2, '0')}`; };

// ── 種類 ───────────────────────────────────
function categoryList(articles) {
  const names = [...new Set(articles.map((a) => a.category || '学習'))];
  const known = Object.keys(CATEGORY_SLUGS).filter((n) => names.includes(n));
  const other = names.filter((n) => !(n in CATEGORY_SLUGS)).sort();
  return [...known, ...other].map((name, i) => ({
    name,
    slug: CATEGORY_SLUGS[name] ?? `c-${i + 1}`,
  }));
}

// ── ひな形 ──────────────────────────────────
const STYLE = `
:root{--navy:#1f4b8e;--ink:#17213a;--sub:#56627a;--paper:#fff;--wash:#f2f5fa;--line:#dce3ee;--chip:#dfe7f8;--card:#fff;
  --font:"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI","Yu Gothic",Meiryo,sans-serif}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--navy:#8fb0ea;--ink:#e7ecf5;--sub:#a4b0c6;--paper:#111a2b;--wash:#0b1322;--line:#26344d;--chip:#233a63;--card:#16213a}}
:root[data-theme="dark"]{--navy:#8fb0ea;--ink:#e7ecf5;--sub:#a4b0c6;--paper:#111a2b;--wash:#0b1322;--line:#26344d;--chip:#233a63;--card:#16213a}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--wash);color:var(--ink);font-family:var(--font);font-size:16px;line-height:1.85}
img{max-width:100%;height:auto;display:block}
a{color:var(--navy)}
a:focus-visible{outline:3px solid var(--navy);outline-offset:2px;border-radius:4px}
.wrap{max-width:760px;margin:0 auto;padding-inline:16px}
.site{background:var(--paper);border-bottom:1px solid var(--line)}
.site .wrap{display:flex;align-items:center;gap:12px;min-height:56px}
.brand{font-weight:800;font-size:18px;text-decoration:none;color:var(--ink);letter-spacing:.02em}
.brand span{color:var(--navy)}
.cats{display:flex;gap:6px;overflow-x:auto;padding:12px 0 4px;scrollbar-width:none}
.cats a{flex:0 0 auto;font-size:13px;text-decoration:none;color:var(--sub);background:var(--paper);border:1px solid var(--line);border-radius:999px;padding:4px 12px}
.cats a[aria-current="page"]{background:var(--navy);border-color:var(--navy);color:var(--paper)}
main{padding-block:16px 40px}
.list-title{font-size:20px;margin:12px 0 4px}
.cards{display:grid;gap:14px;margin-top:12px}
@media (min-width:640px){.cards{grid-template-columns:1fr 1fr}.cards .card:first-child{grid-column:1/-1}}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;text-decoration:none;color:inherit;display:block}
.card:hover{border-color:var(--navy)}
.card img{aspect-ratio:1200/630;object-fit:cover;width:100%;background:var(--chip)}
.card .body{padding:12px 14px 14px}
.card h2{font-size:16px;line-height:1.55;margin:0}
.cards .card:first-child h2{font-size:19px}
.meta{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center;font-size:12px;color:var(--sub);margin-top:6px}
.pr{border:1px solid currentColor;border-radius:3px;padding:0 4px;line-height:1.5}
.empty{color:var(--sub);padding:24px 0}
article{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
article .hero{aspect-ratio:1200/630;object-fit:cover;width:100%;background:var(--chip)}
article .content{padding:18px 18px 24px}
article h1{font-size:23px;line-height:1.5;margin:0}
.md{font-size:17px;line-height:1.95}
.md h2{font-size:20px;margin:28px 0 8px;line-height:1.5}
.md h3{font-size:18px;margin:24px 0 6px;line-height:1.5}
.md p{margin:14px 0}
.md ul{padding-left:1.3em;margin:12px 0}
.md li{margin:4px 0}
.linkbtn{display:block;text-align:center;border:1px solid var(--line);border-radius:10px;padding:12px;margin-top:24px;text-decoration:none;font-weight:600}
.linkbtn:hover{border-color:var(--navy)}
.app{margin-top:20px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;font-size:14px;color:var(--sub)}
.app p{margin:0 0 10px}
.app .badges{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.app .badges img{height:40px;width:auto}
.back{display:inline-block;margin-top:20px;font-size:14px}
footer{font-size:13px;color:var(--sub);padding-block:24px 40px;border-top:1px solid var(--line);background:var(--paper)}
footer p{margin:0 0 8px;line-height:1.7}
footer .links{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:10px}
footer a{color:var(--sub)}
`;

function page({ title, description, path, image, type = 'website', body, jsonLd }) {
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
<meta name="theme-color" content="#1f4b8e">
<link rel="icon" type="image/png" href="/sharoushi/img/favicon.png">
<link rel="stylesheet" href="${BASE}style.css">
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>\n` : ''}</head>
<body>
<header class="site"><div class="wrap"><a class="brand" href="${BASE}">しゃろ勉<span>ニュース</span></a></div></header>
${body}
<footer><div class="wrap">
<p>運営：<a href="/">合同会社たでぃまる</a></p>
<p>記事に誤りがあることが分かった場合は、速やかに修正し、必要に応じて記事内にその旨を記載します。</p>
<div class="links"><a href="${BASE}">記事の一覧</a><a href="/sharoushi/">アプリ「社労士勉強くん」</a><a href="/privacy/">プライバシーポリシー</a></div>
</div></footer>
</body>
</html>
`;
}

function cats(categories, current) {
  const link = (href, label, on) => `<a href="${href}"${on ? ' aria-current="page"' : ''}>${esc(label)}</a>`;
  return `<nav class="cats" aria-label="種類">${link(BASE, 'すべて', current == null)}${categories.map((c) => link(`${BASE}category/${c.slug}/`, c.name, current === c.slug)).join('')}</nav>`;
}

function meta(a) {
  return `<div class="meta">${a.is_pr ? '<span class="pr">PR</span>' : ''}<span>${esc(a.category || '学習')}</span><time datetime="${isoDate(a.published_at)}">${fmtDate(a.published_at)}</time></div>`;
}

function card(a) {
  return `<a class="card" href="${BASE}${a.id}/"><img src="${esc(a.image_url)}" alt="" width="1200" height="630" loading="lazy"><div class="body"><h2>${esc(a.title)}</h2>${meta(a)}</div></a>`;
}

function listPage(articles, categories, current) {
  const cat = categories.find((c) => c.slug === current);
  const heading = cat ? cat.name : '新着';
  const title = cat ? `${cat.name}の記事｜${MEDIA}` : `${MEDIA}｜社労士試験の勉強と、人事・労務の話題`;
  const description = cat
    ? `${MEDIA}の「${cat.name}」の記事の一覧です。`
    : `社労士試験の勉強のしかたや、法改正・採用・人事制度など人事と労務の話題を届ける${MEDIA}。運営は合同会社たでぃまる。`;
  const path = cat ? `${BASE}category/${cat.slug}/` : BASE;
  const body = `<main><div class="wrap">
${cats(categories, current ?? null)}
<h1 class="list-title">${esc(heading)}</h1>
${articles.length ? `<div class="cards">${articles.map(card).join('\n')}</div>` : '<p class="empty">記事を準備しています。</p>'}
</div></main>`;
  return page({ title, description, path, image: articles[0]?.image_url, body });
}

function articlePage(a, categories) {
  const path = `${BASE}${a.id}/`;
  const cat = categories.find((c) => c.name === (a.category || '学習'));
  const rel = a.is_pr ? 'sponsored noopener noreferrer' : 'noopener noreferrer';
  const link = a.link_url && /^https?:\/\//.test(a.link_url)
    ? `<a class="linkbtn" href="${esc(a.link_url)}" target="_blank" rel="${rel}">${esc(a.link_label || 'くわしく見る')} ↗</a>`
    : '';
  const description = describe(a);
  const body = `<main><div class="wrap">
${cats(categories, cat?.slug)}
<article>
<img class="hero" src="${esc(a.image_url)}" alt="" width="1200" height="630">
<div class="content">
<h1>${esc(a.title)}</h1>
${meta(a)}
<div class="md">
${renderMarkdown(a.body, rel)}
</div>
${link}
</div>
</article>
<aside class="app">
<p>社労士試験の勉強には、スマートフォンで1日10問ずつ解けるアプリ「<a href="/sharoushi/">社労士勉強くん</a>」もあります。</p>
<div class="badges">
<a href="${APP_STORE}" target="_blank" rel="noopener"><img src="/assets/badges/app-store-ja.svg" alt="App Store からダウンロード" width="120" height="40"></a>
<a href="${GOOGLE_PLAY}" target="_blank" rel="noopener"><img src="/assets/badges/google-play-ja.png" alt="Google Play で手に入れよう" width="135" height="40"></a>
</div>
</aside>
<a class="back" href="${BASE}">← 記事の一覧へ</a>
</div></main>`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: a.title,
    image: [a.image_url],
    datePublished: new Date(a.published_at).toISOString(),
    author: { '@type': 'Organization', name: '合同会社たでぃまる', url: SITE + '/' },
    publisher: { '@type': 'Organization', name: '合同会社たでぃまる', url: SITE + '/' },
    mainEntityOfPage: SITE + path,
  };
  return page({ title: `${a.title}｜${MEDIA}`, description, path, image: a.image_url, type: 'article', body, jsonLd });
}

function sitemap(articles, categories) {
  const latest = articles[0] ? isoDate(articles[0].published_at) : null;
  const url = (loc, extra) => `  <url><loc>${esc(SITE + loc)}</loc>${extra}</url>`;
  const lines = [
    ...STATIC_URLS.map(([loc, freq]) => url(loc, `<changefreq>${freq}</changefreq>`)),
    url(BASE, `${latest ? `<lastmod>${latest}</lastmod>` : ''}<changefreq>daily</changefreq>`),
    ...categories.map((c) => {
      const first = articles.find((a) => (a.category || '学習') === c.name);
      return url(`${BASE}category/${c.slug}/`, `<lastmod>${isoDate(first.published_at)}</lastmod><changefreq>weekly</changefreq>`);
    }),
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
  await rm(OUT, { recursive: true, force: true });
  await write(join(OUT, 'style.css'), STYLE.trimStart());
  await write(join(OUT, 'index.html'), listPage(articles, categories, null));
  for (const c of categories) {
    const inCat = articles.filter((a) => (a.category || '学習') === c.name);
    await write(join(OUT, 'category', c.slug, 'index.html'), listPage(inCat, categories, c.slug));
  }
  for (const a of articles) {
    await write(join(OUT, String(a.id), 'index.html'), articlePage(a, categories));
  }
  await write(join(ROOT, 'sitemap.xml'), sitemap(articles, categories));
  console.log(`記事 ${articles.length} 本・種類 ${categories.length} 個を書き出した`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
