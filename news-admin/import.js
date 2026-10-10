// ニュース管理ページ：「まとめて読み込む」（2026-10-10）
//
// G ドライブで作った記事ファイル（開発企画課/tickets/rom/open/2026-10-10-rom-news-article-spec.md の 6. の形）を
// 画像と一緒に読み込み、検査して一覧にし、選んだものをまとめて保存（予約公開／下書き）する。
//   ・取り込むのは status: 公開OK だけ。publish_at があれば予約公開、空なら下書き
//   ・同じファイル名（source_file）を読み込み直したら、新しく作らずに直す（二重登録しない）
//   ・すでに公開中の記事を直すときは、公開日時を変えない
// index.html の sb・$・cropTo1200x630・renderMarkdown・fillPreview・loadList・articles・esc・BUCKET を使う。
// 関連：開発企画課/tickets/rom/open/2026-10-10-rom-news-bulk-import.md
//       開発課/社労士アプリ/本体/supabase_news_bulk_import.sql（source_file 列・画像の上書きの権限）
'use strict';

const IMPORT = {
  rows: [],       // 取り込む候補（status: 公開OK の記事）
  skipped: [],    // 弾いたファイル { name, reason }
  activeName: null,
  objectUrls: [],
};

const KNOWN_CATEGORIES = ['学習', '法改正', '採用', '人事制度'];
const BODY_MIN = 800, BODY_MAX = 2000, BODY_LIMIT = 20000;
const IMAGE_LIMIT = 300 * 1024;

// ── ファイルを受け取る ────────────────────────────
$('pickFiles').onclick = () => $('importFiles').click();
$('pickFolder').onclick = () => $('importFolder').click();
$('importFiles').onchange = () => { importFiles([...$('importFiles').files]); $('importFiles').value = ''; };
$('importFolder').onchange = () => { importFiles([...$('importFolder').files]); $('importFolder').value = ''; };

const drop = $('importDrop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', async (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  const files = entries.length ? (await Promise.all(entries.map(filesOfEntry))).flat() : [...e.dataTransfer.files];
  importFiles(files);
});

// フォルダを落とされたら、中を全部たどる
async function filesOfEntry(entry) {
  if (entry.isFile) {
    const f = await new Promise((res, rej) => entry.file(res, rej));
    f.relPath = entry.fullPath; // 落としたフォルダの中の場所（同じ名前の画像の見分けに使う）
    return [f];
  }
  const reader = entry.createReader();
  const children = [];
  for (;;) {
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    children.push(...batch);
  }
  return (await Promise.all(children.map(filesOfEntry))).flat();
}

// ── 読み込み → 検査 ─────────────────────────────
async function importFiles(files) {
  for (const u of IMPORT.objectUrls) URL.revokeObjectURL(u);
  IMPORT.objectUrls = [];
  IMPORT.rows = []; IMPORT.skipped = []; IMPORT.activeName = null;
  importMessage('読み込んでいます…', true);

  const images = new Map(); // ファイル名（小文字）→ File
  const mds = [];
  for (const f of files) {
    const lower = f.name.toLowerCase();
    if (/\.(png|jpe?g)$/.test(lower)) {
      if (!images.has(lower)) images.set(lower, []);
      images.get(lower).push(f);
    } else if (lower.endsWith('.md')) {
      if (f.name.startsWith('_')) IMPORT.skipped.push({ name: f.name, reason: '「_」で始まるファイル（一覧など）' });
      else mds.push(f);
    }
  }

  const seen = new Map();
  for (const f of mds) {
    const name = f.name.replace(/\.md$/i, '');
    let parsed;
    try {
      parsed = parseArticle(await f.text());
    } catch (e) {
      parsed = null;
    }
    if (!parsed || !('title' in parsed.fm)) {
      IMPORT.skipped.push({ name: f.name, reason: '記事のファイルではない（先頭に --- で囲んだ項目が無い）' });
      continue;
    }
    const status = parsed.fm.status || '（空）';
    if (status !== '公開OK') {
      IMPORT.skipped.push({ name: f.name, reason: `status が「${status}」（取り込むのは「公開OK」だけ）` });
      continue;
    }
    const row = { name, file: f, fm: parsed.fm, body: parsed.body, errors: [], warnings: [], selected: false, result: null };
    if (seen.has(name)) {
      seen.get(name).errors.push('同じ名前のファイルが2つある（どちらが正しいか分からないので止める）');
      continue;
    }
    seen.set(name, row);
    IMPORT.rows.push(row);
  }

  if (IMPORT.rows.length && articles.length && !('source_file' in articles[0])) {
    importMessage('先に supabase_news_bulk_import.sql を SQL Editor で流してください（読み込み直しで二重にならないための列がまだありません）。', false);
  }

  for (const row of IMPORT.rows) {
    checkRow(row);
    await prepareImage(row, images);
    matchExisting(row);
    row.selected = row.errors.length === 0 && row.changes !== 'none';
  }
  IMPORT.rows.sort((a, b) => a.name.localeCompare(b.name));
  renderImport();
  if (!IMPORT.rows.length) importMessage('取り込める記事（status: 公開OK）がありませんでした。', false);
  else if ($('importMessage').className !== 'ng') importMessage('', true);
}

// 先頭の項目（frontmatter）と本文に分ける。article-spec 6. の形（YAML のごく一部）だけを読む：
//   key: 値   # コメント     ／   key:（改行）  - 項目
function parseArticle(text) {
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return null;
  const after = text.indexOf('\n', end + 4);
  const head = text.slice(4, end);
  const body = after < 0 ? '' : text.slice(after + 1);
  const fm = {};
  let lastKey = null;
  for (const line of head.split('\n')) {
    const item = line.match(/^\s+-\s*(.*)$/);
    if (item && lastKey) {
      if (!Array.isArray(fm[lastKey])) fm[lastKey] = [];
      fm[lastKey].push(scalar(item[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) { fm[kv[1]] = scalar(kv[2]); lastKey = kv[1]; }
  }
  return { fm, body: body.trim() };
}

// 値1つ。引用符で囲んであれば中身、そうでなければ行末の「 # コメント」を外す
function scalar(raw) {
  const v = raw.trim();
  const q = v.match(/^"((?:[^"\\]|\\.)*)"|^'((?:[^']|'')*)'/);
  if (q) return q[1] !== undefined ? q[1].replace(/\\(.)/g, '$1') : q[2].replace(/''/g, "'");
  return v.replace(/\s+#.*$/, '').trim();
}

// 日時は日本時間として読む（「2026-10-15 07:00」）。時刻が無ければ朝7時
function parseJst(text, row) {
  const m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (!m) return null;
  if (m[4] === undefined) row.warnings.push('publish_at に時刻が無いので、朝7:00 にしました');
  const iso = `${m[1]}-${pad(+m[2])}-${pad(+m[3])}T${pad(+(m[4] ?? 7))}:${m[5] ?? '00'}:00+09:00`;
  const d = new Date(iso);
  return isNaN(d) ? null : d;
}

function checkRow(row) {
  const { fm, body, errors, warnings } = row;
  const str = (k) => (typeof fm[k] === 'string' ? fm[k] : '');
  row.title = str('title');
  row.category = str('category');
  row.linkUrl = str('link_url');
  row.linkLabel = str('link_label');

  if (!row.title) errors.push('title（見出し）が無い');
  else if ([...row.title].length > 80) errors.push(`見出しが80文字を超えている（${[...row.title].length}文字）`);

  if (!row.category) errors.push('category（種類）が無い');
  else if ([...row.category].length > 20) errors.push('種類が20文字を超えている');
  else if (!KNOWN_CATEGORIES.includes(row.category)) warnings.push(`種類「${row.category}」は決まった4つ（${KNOWN_CATEGORIES.join('・')}）にない`);

  const pr = str('is_pr');
  if (pr === '' || pr === 'false') row.isPr = false;
  else if (pr === 'true') row.isPr = true;
  else errors.push(`is_pr は true か false（いまは「${pr}」）`);

  if (row.linkUrl && !/^https?:\/\/\S+$/.test(row.linkUrl)) errors.push('link_url は http:// か https:// で始める');
  if ([...row.linkLabel].length > 40) errors.push('link_label が40文字を超えている');
  if (row.linkLabel && !row.linkUrl) warnings.push('link_label があるのに link_url が無い（ボタンは出ない）');

  // 法的な内容を確かめずに出さない（AI が書いた記事は代表の確認が要る）
  const reviewed = str('reviewed');
  if (!reviewed || reviewed.startsWith('未')) errors.push('reviewed が空か「未」（代表の確認が済んでいない）');

  const publishAt = str('publish_at');
  row.publishAt = null;
  if (publishAt) {
    row.publishAt = parseJst(publishAt, row);
    if (!row.publishAt) errors.push(`publish_at が日時として読めない（「${publishAt}」。例 2026-10-15 07:00）`);
  }

  // 本文：アプリが読める書き方だけ（lib/widgets/simple_markdown.dart と同じ）
  if (!body) errors.push('本文が無い');
  const length = [...body.replace(/\s/g, '')].length;
  row.length = length;
  if (length > BODY_LIMIT) errors.push(`本文が長すぎる（${length}文字。上限は${BODY_LIMIT}文字）`);
  else if (body && (length < BODY_MIN || length > BODY_MAX)) warnings.push(`本文が ${length}文字（目安は${BODY_MIN}〜${BODY_MAX}文字）`);
  const bad = [
    [/^\s*\|.*\|\s*$/, '表'],
    [/^\s*\d+[.．)]\s/, '番号つき箇条書き（1. など）'],
    [/^\s*>/, '引用（>）'],
    [/!\[[^\]]*\]\([^)]*\)/, '画像（![]()）'],
  ];
  const deep = [];
  body.split('\n').forEach((line, i) => {
    for (const [re, label] of bad) if (re.test(line)) errors.push(`${i + 1}行目：${label}はアプリで使えない`);
    if (/^#{3,}\s/.test(line)) deep.push(i + 1);
  });
  if (deep.length) warnings.push(`${deep.join('・')}行目：### は見出しにならない（# か ## にする）`);
}

// 画像：image の値か、同じ名前の .png / .jpg。1200×630 に切り抜いて縮め、300KB を超えたら止める
async function prepareImage(row, images) {
  const wanted = (typeof row.fm.image === 'string' && row.fm.image) || '';
  const candidates = wanted ? [wanted] : [row.name + '.png', row.name + '.jpg', row.name + '.jpeg'];
  const base = (p) => p.split(/[\\/]/).pop().toLowerCase();
  const same = candidates.map((c) => images.get(base(c))).find(Boolean) || [];
  const found = same[0];
  if (same.length > 1 && new Set(same.map((f) => f.size)).size > 1) {
    const where = (f) => f.relPath || f.webkitRelativePath || f.name;
    row.warnings.push(`同じ名前の画像が${same.length}つあり、中身が違う。「${where(found)}」を使う（違うならプレビューで確かめて、片方だけ選び直す）`);
  }
  if (!found) {
    row.errors.push(wanted ? `画像「${wanted}」が見つからない（記事と一緒に選んでください）` : 'image（画像）が無い');
    return;
  }
  if (!/\.(png|jpe?g)$/i.test(found.name)) { row.errors.push('画像は PNG か JPEG だけ'); return; }
  row.imageName = found.name;
  try {
    row.imageBlob = await cropTo1200x630(found);
  } catch (e) {
    row.errors.push(`画像「${found.name}」を読めない`);
    return;
  }
  if (row.imageBlob.size > IMAGE_LIMIT) {
    row.errors.push(`画像を縮めても ${Math.round(row.imageBlob.size / 1024)}KB（300KB まで）。細かい模様の少ない画像にする`);
  }
  const digest = await crypto.subtle.digest('SHA-256', await row.imageBlob.arrayBuffer());
  row.imageHash = [...new Uint8Array(digest)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');
  // 置き場は記事ごとに固定（読み込み直したら上書き）。URL の ?v= は画像が変わったときだけ変わる（古い画像が残って見えないように）
  const path = /^[A-Za-z0-9._-]+$/.test(row.name) ? `bulk/${row.name}.jpg` : `bulk/${row.imageHash}.jpg`;
  row.imagePath = path;
  row.imageUrl = sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl + '?v=' + row.imageHash;
  row.previewSrc = URL.createObjectURL(row.imageBlob);
  IMPORT.objectUrls.push(row.previewSrc);
}

// すでにある記事と突き合わせる（ファイル名。無ければ、1本ずつ書いた記事を見出しで）
function matchExisting(row) {
  row.existing = articles.find((a) => a.source_file === row.name)
    || articles.find((a) => !a.source_file && a.title === row.title)
    || null;
  const live = row.existing && row.existing.is_published && new Date(row.existing.published_at) <= new Date();
  row.live = !!live;
  if (live) {
    // 公開中の記事は、公開のまま・日時も変えない
    row.isPublished = true;
    row.publishedAt = row.existing.published_at;
  } else if (row.publishAt) {
    row.isPublished = true;
    row.publishedAt = row.publishAt.toISOString();
  } else {
    row.isPublished = false;
    row.publishedAt = row.existing ? row.existing.published_at : new Date().toISOString();
  }
  row.pastPublish = !live && row.isPublished && new Date(row.publishedAt) <= new Date();
  if (row.pastPublish) row.warnings.push('publish_at が過ぎているので、保存するとすぐ公開になる');

  row.changes = null;
  if (row.existing) {
    const e = row.existing;
    const diff = [];
    if (e.title !== row.title) diff.push('見出し');
    if (e.body !== row.body) diff.push('本文');
    if (e.category !== row.category) diff.push('種類');
    if ((e.link_url || '') !== row.linkUrl || (e.link_label || '') !== row.linkLabel) diff.push('リンク');
    if (!!e.is_pr !== row.isPr) diff.push('PR');
    if (e.image_url !== row.imageUrl) diff.push('画像');
    if (e.is_published !== row.isPublished || new Date(e.published_at).getTime() !== new Date(row.publishedAt).getTime()) diff.push('公開');
    if (!e.source_file) diff.push('ファイル名のひもづけ');
    row.changes = diff.length ? diff : 'none';
  }
}

// ── 一覧 ───────────────────────────────────
function renderImport() {
  const rows = IMPORT.rows;
  const errors = rows.filter((r) => r.errors.length).length;
  $('importSummary').textContent = rows.length || IMPORT.skipped.length
    ? `取り込む候補 ${rows.length}本（うちエラー ${errors}本）・弾いたファイル ${IMPORT.skipped.length}件`
    : '';
  $('importTable').classList.toggle('hidden', rows.length === 0);
  const tbody = $('importTable').querySelector('tbody');
  tbody.innerHTML = '';
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.className = 'row-item' + (IMPORT.activeName === row.name ? ' active' : '');
    const publish = row.live ? '公開中のまま'
      : row.isPublished ? (row.pastPublish ? 'すぐ公開' : '予約 ' + fmtDateTime(row.publishedAt))
      : '下書き';
    const reg = !row.existing ? '新規'
      : !Array.isArray(row.changes) ? '変更なし'
      : '更新（' + row.changes.join('・') + '）';
    tr.innerHTML = `
      <td><input type="checkbox"></td>
      <td><div class="t"></div><div class="file"></div><ul class="issues"></ul></td>
      <td class="c"></td><td class="p"></td><td class="i"></td><td class="r"></td><td class="result"></td>`;
    const box = tr.querySelector('input');
    box.checked = row.selected;
    box.disabled = row.errors.length > 0;
    box.onclick = (e) => { e.stopPropagation(); row.selected = box.checked; updateSaveButton(); };
    tr.querySelector('.t').textContent = row.title || '（見出しなし）';
    tr.querySelector('.file').textContent = row.file.name + (row.length ? `・${row.length}文字` : '');
    const issues = tr.querySelector('.issues');
    for (const [list, cls] of [[row.errors, 'e'], [row.warnings, 'w']]) {
      for (const text of list) {
        const li = document.createElement('li');
        li.className = cls; li.textContent = text;
        issues.appendChild(li);
      }
    }
    tr.querySelector('.c').textContent = row.category;
    tr.querySelector('.p').textContent = publish;
    tr.querySelector('.i').textContent = row.imageBlob ? `あり（${Math.round(row.imageBlob.size / 1024)}KB）` : 'なし';
    tr.querySelector('.r').textContent = reg;
    if (row.result) {
      const cell = tr.querySelector('.result');
      cell.textContent = row.result.text;
      cell.classList.add(row.result.ok ? 'ok' : 'ng');
    }
    tr.onclick = () => { IMPORT.activeName = row.name; renderImport(); previewRow(row); };
    tbody.appendChild(tr);
  }
  const sk = $('importSkipped');
  sk.classList.toggle('hidden', IMPORT.skipped.length === 0);
  sk.querySelector('summary').textContent = `弾いたファイル ${IMPORT.skipped.length}件（理由を見る）`;
  sk.querySelector('ul').innerHTML = '';
  for (const s of IMPORT.skipped) {
    const li = document.createElement('li');
    li.textContent = `${s.name}：${s.reason}`;
    sk.querySelector('ul').appendChild(li);
  }
  const selectable = rows.filter((r) => !r.errors.length);
  $('importAll').checked = selectable.length > 0 && selectable.every((r) => r.selected);
  $('importAll').disabled = selectable.length === 0;
  updateSaveButton();
}

$('importAll').onclick = () => {
  for (const r of IMPORT.rows) if (!r.errors.length) r.selected = $('importAll').checked;
  renderImport();
};

function updateSaveButton() {
  const n = IMPORT.rows.filter((r) => r.selected && !r.errors.length).length;
  $('importSave').disabled = n === 0;
  $('importSave').textContent = n ? `選んだ記事を保存（${n}本）` : '選んだ記事を保存';
}

function previewRow(row) {
  fillPreview('ipv', {
    title: row.title, category: row.category, isPr: row.isPr,
    when: new Date(row.publishedAt || Date.now()),
    src: row.previewSrc || '', body: row.body, linkUrl: row.linkUrl, linkLabel: row.linkLabel,
  });
}

// ── まとめて保存（1本ずつ順に。失敗した行は選んだまま残るので、もう一度押せば続きから） ──
$('importSave').onclick = async () => {
  const targets = IMPORT.rows.filter((r) => r.selected && !r.errors.length);
  if (!targets.length) return;
  const now = targets.filter((r) => r.pastPublish).map((r) => '・' + r.title);
  if (now.length && !confirm(`次の記事は publish_at が過ぎているので、保存するとすぐアプリに出ます。\n\n${now.join('\n')}\n\nよろしいですか？`)) return;

  $('importSave').disabled = true;
  let ok = 0;
  for (const row of targets) {
    row.result = { ok: true, text: '保存しています…' };
    renderImport();
    try {
      let url = row.existing && row.existing.image_url === row.imageUrl ? row.imageUrl : null;
      if (!url) {
        const { error: upErr } = await sb.storage.from(BUCKET).upload(row.imagePath, row.imageBlob, { contentType: 'image/jpeg', upsert: true });
        if (upErr) throw new Error('画像を上げられませんでした：' + upErr.message);
        url = row.imageUrl;
      }
      const data = {
        source_file: row.name,
        title: row.title, body: row.body, category: row.category, image_url: url,
        link_url: row.linkUrl || null, link_label: row.linkLabel || null,
        is_pr: row.isPr, is_published: row.isPublished, published_at: row.publishedAt,
      };
      const q = row.existing
        ? sb.from('news_articles').update(data).eq('id', row.existing.id).select().single()
        : sb.from('news_articles').insert(data).select().single();
      const { data: saved, error } = await q;
      if (error) throw new Error(error.message);
      row.existing = saved;
      // 保存した結果で突き合わせ直す（以前はここで突き合わせず、一覧を描き直すところで落ちて、2本目以降が保存されなかった）
      row.warnings = row.warnings.filter((w) => !w.startsWith('publish_at が過ぎている'));
      matchExisting(row);
      row.selected = false;
      row.result = { ok: true, text: '保存しました' };
      ok++;
    } catch (e) {
      row.result = { ok: false, text: '失敗：' + e.message };
    }
    renderImport();
  }
  await loadList();
  // 保存した結果で突き合わせ直す（もう一度押しても二重にならない）
  for (const row of IMPORT.rows) {
    row.warnings = row.warnings.filter((w) => !w.startsWith('publish_at が過ぎている'));
    matchExisting(row);
  }
  renderImport();
  const failed = targets.length - ok;
  importMessage(failed ? `${ok}本を保存しました。${failed}本は失敗しました（選んだまま残してあるので、もう一度押すと続きから）。` : `${ok}本を保存しました。`, failed === 0);
};

function importMessage(text, ok) {
  $('importMessage').textContent = text;
  $('importMessage').className = ok ? 'hint' : 'ng';
  $('importMessage').style.color = ok ? '' : 'var(--ng)';
}
