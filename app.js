'use strict';
// 7S組織診断 公開版フロント: GAS Web アプリに URL を送信 → 10 秒間隔で status をポーリング →
// done で job.result を描画。result の文字列はすべて esc() を通して埋め込む（XSS対策）。
// 履歴はサーバー一覧APIを持たないため localStorage に保存する（自分が実行したジョブのみ）。

// ▼ デプロイ後、この値を GAS ウェブアプリの /exec URL に置き換える（DEPLOY.md 参照）
const API = 'https://script.google.com/macros/s/AKfycbwcTanUcsM6sLMOTdZH_S1BH2U_j3oezYCD1nEH7zgG0Aa6wY39datkNNGpEv26T3ud/exec';

const LS_HISTORY = '7s_history';
const POLL_MS = 10000; // GAS は毎分トリガー処理のため 10 秒間隔で十分

const $ = (s) => document.querySelector(s);
const el = {
  form: $('#form'), url: $('#url'), submit: $('#submit'),
  deployNote: $('#deployNote'),
  progress: $('#progress'), phaseText: $('#phaseText'), phaseUrl: $('#phaseUrl'),
  elapsed: $('#elapsed'), steps: $('#steps'),
  errorBox: $('#errorBox'), errorMsg: $('#errorMsg'), errorLog: $('#errorLog'), retryBtn: $('#retryBtn'),
  report: $('#report'), history: $('#history'), histList: $('#histList'),
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// 7S の表示順・短縮ラベル・タイプ（レーダーとカードで共通利用）
const KEYS = ['strategy', 'structure', 'system', 'sharedValues', 'staff', 'skill', 'style'];
const SHORT = {
  strategy: '戦略', structure: '組織構造', system: 'システム',
  sharedValues: '価値観', staff: '人材', skill: 'スキル', style: '風土',
};
const TYPE = {
  strategy: 'hard', structure: 'hard', system: 'hard',
  sharedValues: 'soft', staff: 'soft', skill: 'soft', style: 'soft',
};
const COL = { hard: '#0068B6', soft: '#FB4113' };

let pollTimer = null, tickTimer = null, startMs = 0;
let currentReport = null; // { result, job } — Markdown ダウンロード用

const notDeployed = () => typeof API !== 'string' || API.indexOf('{{') >= 0;

init();
function init() {
  if (notDeployed()) el.deployNote.hidden = false;
  el.form.addEventListener('submit', (e) => { e.preventDefault(); start(); });
  el.retryBtn.addEventListener('click', () => { reset(); el.url.focus(); });
  renderHistory();
}

async function start() {
  const url = el.url.value.trim();
  if (!url) { el.url.focus(); return; }
  if (notDeployed()) { showError('接続先（GASウェブアプリURL）が未設定です。管理者にお問い合わせください。', ''); return; }

  el.submit.disabled = true;
  el.errorBox.hidden = true;
  el.report.hidden = true;
  el.report.innerHTML = '';
  try {
    // プリフライト回避のため text/plain で送る
    const r = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'analyze', url }),
    });
    const j = await r.json();
    if (!j || j.error) throw new Error((j && j.error) || '送信に失敗しました');
    saveHistory({ id: j.id, url, date: new Date().toISOString().slice(0, 10) });
    renderHistory();
    beginProgress(url, j.id);
  } catch (e) {
    el.submit.disabled = false;
    showError(e.message, '');
  }
}

function beginProgress(url, id) {
  el.progress.hidden = false;
  el.phaseUrl.textContent = url;
  el.phaseText.textContent = 'キューに投入しました…';
  setStep('research', 'active');
  setStep('done', '');
  startMs = Date.now();
  tickTimer = setInterval(() => { el.elapsed.textContent = Math.round((Date.now() - startMs) / 1000); }, 500);
  pollTimer = setInterval(() => poll(id), POLL_MS);
  poll(id);
}

async function poll(id) {
  let j;
  try {
    j = await (await fetch(API + '?fn=status&id=' + encodeURIComponent(id))).json();
  } catch (_) { return; }
  // 注意: ジョブ自体も失敗理由を j.error に持つ。API エラー（not found 等）は status が無いことで区別する
  if (!j || (j.error && !j.status)) return;
  el.phaseText.textContent = j.phase || j.status;
  if (j.status === 'running' || j.status === 'queued') {
    setStep('research', j.status === 'running' ? 'active' : '');
  } else if (j.status === 'done') {
    stopTimers();
    setStep('research', 'done'); setStep('done', 'done');
    renderReport(j);
    el.progress.hidden = true;
    el.submit.disabled = false;
  } else if (j.status === 'failed') {
    stopTimers();
    el.progress.hidden = true;
    el.submit.disabled = false;
    showError(j.phase || '診断に失敗しました', j.error || '');
  }
}

function setStep(k, state) {
  const s = el.steps.querySelector(`[data-k="${k}"]`);
  if (s) s.className = 'step ' + state;
}
function stopTimers() { clearInterval(pollTimer); clearInterval(tickTimer); pollTimer = tickTimer = null; }
function showError(msg, log) {
  el.errorBox.hidden = false; el.errorMsg.textContent = msg;
  el.errorLog.textContent = log || ''; el.errorLog.style.display = log ? 'block' : 'none';
  el.errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function reset() { el.errorBox.hidden = true; el.report.hidden = true; el.progress.hidden = true; }

// ---- レポート描画 --------------------------------------------------------
function renderReport(job) {
  const d = job.result;
  if (!d) return showError('レポートデータが取得できませんでした', '');
  currentReport = { result: d, job: job };
  const c = d.company || {};
  const meta = d.meta || {};
  const date = meta.analyzedAt || String(job.createdAt || '').slice(0, 10);
  const name = c.name || job.companyName || job.url || '対象企業';

  let html = `
  <div class="rep-head">
    <div class="rep-title">
      <h2>${esc(name)}</h2>
      <div class="date">診断日: ${esc(date)}　·　マッキンゼー7Sフレームワーク</div>
      ${c.url ? `<div class="url">${esc(c.url)}</div>` : ''}
    </div>
    <button class="dl-btn" id="dlBtn" type="button">⬇ Markdownダウンロード</button>
  </div>

  <div class="conclusion-card">
    <div class="lbl">結論</div>
    <p>${esc(d.conclusion || '（結論の記載なし）')}</p>
  </div>

  <div class="card radar-card">
    ${radarSvg(d.sevenS || {})}
    <div class="radar-legend">
      <span><i style="background:${COL.hard}"></i>ハードの3S（戦略・組織構造・システム）</span>
      <span><i style="background:${COL.soft}"></i>ソフトの4S（価値観・人材・スキル・風土）</span>
      <span>各軸のスコア = 1〜5</span>
    </div>
  </div>`;

  // ハードの3S
  html += `<h3 class="sec-title">ハードの3S分析<span class="side">Strategy / Structure / System</span></h3>`;
  html += `<div class="s-grid">${['strategy', 'structure', 'system'].map((k) => sCard(k, (d.sevenS || {})[k])).join('')}</div>`;

  // ソフトの4S
  html += `<h3 class="sec-title">ソフトの4S分析<span class="side">Shared Values / Staff / Skill / Style</span></h3>`;
  html += `<div class="s-grid">${['sharedValues', 'staff', 'skill', 'style'].map((k) => sCard(k, (d.sevenS || {})[k])).join('')}</div>`;

  // ギャップ
  html += `<h3 class="sec-title">ハードとソフトのギャップ分析</h3>`;
  const gaps = d.gaps || [];
  if (gaps.length) {
    html += `<div class="gaps">${gaps.map((g, i) => `
      <div class="gap">
        <div class="gt">ギャップ${i + 1}：${esc(g.title || '（無題）')}</div>
        ${g.description ? `<div class="gd">${esc(g.description)}</div>` : ''}
      </div>`).join('')}</div>`;
  } else {
    html += `<p class="note">ギャップの記載はありませんでした。</p>`;
  }

  // 優先変革テーマ
  const t = d.theme || {};
  html += `<h3 class="sec-title">優先的変革テーマの提言</h3>`;
  html += `<div class="theme-card">
    <div class="lbl">提言テーマ</div>
    <div class="tt">${esc(t.title || '（テーマの記載なし）')}</div>
    ${t.reason ? `<p class="reason">${esc(t.reason)}</p>` : ''}
    <div class="actions">${(t.actions || []).map((a, i) => `
      <div class="action">
        <div class="n">${i + 1}</div>
        <div>
          <div class="at">${esc(a.title || 'アクション' + (i + 1))}</div>
          ${a.description ? `<div class="ad">${esc(a.description)}</div>` : ''}
        </div>
      </div>`).join('')}</div>
  </div>`;

  // 会社概要
  html += `<h3 class="sec-title">会社概要</h3>${companyTable(c)}`;

  // 参照資料
  const refs = d.references || [];
  html += `<h3 class="sec-title">参照資料</h3>`;
  if (refs.length) {
    html += `<ul class="refs">${refs.map((r) => {
      const label = esc(r.title || r.url);
      return r.url
        ? `<li><a href="${esc(r.url)}" target="_blank" rel="noopener">${label}</a></li>`
        : `<li>${label}</li>`;
    }).join('')}</ul>`;
  } else {
    html += `<p class="note">参照資料の記載はありませんでした。</p>`;
  }

  if (meta.sourceNote) {
    html += `<p class="note" style="margin-top:14px">注記: ${esc(meta.sourceNote)}</p>`;
  }
  html += `<p class="note" style="margin-top:16px">本診断は公開情報に基づく AI による自動分析です。数値は実データで裏取りの上ご活用ください。</p>`;

  el.report.innerHTML = html;
  el.report.hidden = false;
  const dl = document.getElementById('dlBtn');
  if (dl) dl.addEventListener('click', downloadMarkdown);
  el.report.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function sCard(key, s) {
  s = s || {};
  const type = TYPE[key];
  const label = s.label || SHORT[key];
  const score = Number(s.score) || 0;
  let meta = '';
  if (s.mission) meta += `<div class="s-meta"><b>ミッション/ビジョン:</b> ${esc(s.mission)}</div>`;
  if (s.philosophy) meta += `<div class="s-meta"><b>企業理念:</b> ${esc(s.philosophy)}</div>`;

  const listOr = (arr, emptyMsg) => (arr && arr.length)
    ? `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
    : `<div class="empty">${emptyMsg}</div>`;

  return `<div class="s-card ${type}">
    <div class="s-head">
      <span class="s-name">${esc(label)}</span>
      <span class="s-badge ${type}">${score} / 5</span>
    </div>
    ${meta}
    <div class="s-block up"><div class="h">強み</div>${listOr(s.strengths, '公開情報からは確認できず')}</div>
    <div class="s-block dn"><div class="h">課題</div>${listOr(s.issues, '公開情報からは確認できず')}</div>
  </div>`;
}

function companyTable(c) {
  const rows = [
    ['社名', c.name], ['設立', c.established], ['代表者', c.representative],
    ['資本金', c.capital], ['従業員数', c.employees], ['所在地', c.location],
    ['事業内容', c.business],
  ];
  return `<table class="info-table"><tbody>${rows.map(([k, v]) => `
    <tr><th>${esc(k)}</th><td>${v ? esc(v) : '<span style="color:#9ca3af">公開情報からは確認できず</span>'}</td></tr>`).join('')}</tbody></table>`;
}

// 7軸レーダーチャート（SVG手書き・スコア1〜5・軸ラベルをハード青/ソフト朱で色分け）
function radarSvg(sevenS) {
  const W = 460, H = 460, cx = 230, cy = 232, R = 138;
  const n = KEYS.length;
  const ang = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const pt = (i, r) => [cx + r * Math.cos(ang(i)), cy + r * Math.sin(ang(i))];

  let g = '';
  for (let lvl = 1; lvl <= 5; lvl++) {
    const r = (R * lvl) / 5;
    const poly = KEYS.map((_, i) => pt(i, r).map((v) => v.toFixed(1)).join(',')).join(' ');
    g += `<polygon points="${poly}" fill="${lvl === 5 ? 'rgba(0,104,182,.03)' : 'none'}" stroke="#e3e8ef" stroke-width="1"/>`;
  }
  for (let i = 0; i < n; i++) {
    const [x, y] = pt(i, R);
    g += `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#e3e8ef" stroke-width="1"/>`;
  }
  const dataPts = KEYS.map((k, i) => {
    const sc = Math.max(0, Math.min(5, Number((sevenS[k] || {}).score) || 0));
    return pt(i, (R * sc) / 5);
  });
  const dataPoly = dataPts.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ');
  g += `<polygon points="${dataPoly}" fill="rgba(0,104,182,.18)" stroke="#0068B6" stroke-width="2.5" stroke-linejoin="round"/>`;
  dataPts.forEach((p, i) => {
    const type = TYPE[KEYS[i]];
    g += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4" fill="${COL[type]}" stroke="#fff" stroke-width="1.5"/>`;
  });
  for (let i = 0; i < n; i++) {
    const k = KEYS[i];
    const type = TYPE[k];
    const sc = Number((sevenS[k] || {}).score) || 0;
    const [lx, ly] = pt(i, R + 26);
    const cos = Math.cos(ang(i));
    const anchor = Math.abs(cos) < 0.35 ? 'middle' : (cos > 0 ? 'start' : 'end');
    g += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}" dominant-baseline="middle" font-size="13" font-weight="800" fill="${COL[type]}">${esc(SHORT[k])}</text>`;
    g += `<text x="${lx.toFixed(1)}" y="${(ly + 15).toFixed(1)}" text-anchor="${anchor}" dominant-baseline="middle" font-size="11" fill="#6b7280">${sc}/5</text>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="7S レーダーチャート" xmlns="http://www.w3.org/2000/svg">${g}</svg>`;
}

// ---- Markdown 生成（サーバー版 buildMarkdown と同一構成・クライアントJSで生成） ----
function buildMarkdown(result, job) {
  const c = result.company || {};
  const s = result.sevenS || {};
  const meta = result.meta || {};
  const date = meta.analyzedAt || (job && job.createdAt ? String(job.createdAt).slice(0, 10) : '');
  const target = c.name || (job && job.companyName) || (job && job.url) || '対象企業';

  const bullets = (list) => (!list || !list.length)
    ? '- （公開情報からは確認できず）\n'
    : list.map((x) => `- ${x}`).join('\n') + '\n';
  const sElement = (x) => {
    x = x || {};
    let md = `### ${x.label || ''}\n\n`;
    if (x.mission) md += `**ミッション/ビジョン**: ${x.mission}\n\n`;
    if (x.philosophy) md += `**企業理念**: ${x.philosophy}\n\n`;
    md += `**スコア**: ${x.score || 0} / 5\n\n`;
    md += `**強み**\n\n${bullets(x.strengths)}\n`;
    md += `**課題**\n\n${bullets(x.issues)}\n`;
    return md;
  };

  let md = '';
  md += `**調査日**: ${date}\n`;
  md += `**調査対象**: ${target}\n`;
  md += `**分析手法**: マッキンゼーの7Sフレームワーク\n`;
  md += `**調査目的**: 組織の現状把握と変革テーマの特定\n\n---\n\n`;

  // 1. 結論
  md += `## 1. 結論\n\n${result.conclusion || '（結論の記載なし）'}\n\n---\n\n`;

  // 2. 会社概要
  md += `## 2. 会社概要\n\n| 項目 | 内容 |\n|---|---|\n`;
  const rows = [
    ['社名', c.name], ['設立', c.established], ['代表者', c.representative],
    ['資本金', c.capital], ['従業員数', c.employees], ['所在地', c.location],
    ['事業内容', c.business],
  ];
  for (const [k, v] of rows) {
    const cell = String(v || '').replace(/\|/g, '\\|').replace(/\n/g, ' ') || '（公開情報からは確認できず）';
    md += `| ${k} | ${cell} |\n`;
  }
  md += `\n---\n\n`;

  // 3. ハードの3S分析
  md += `## 3. ハードの3S分析\n\n`;
  md += sElement(s.strategy) + sElement(s.structure) + sElement(s.system) + `---\n\n`;

  // 4. ソフトの4S分析
  md += `## 4. ソフトの4S分析\n\n`;
  md += sElement(s.sharedValues) + sElement(s.staff) + sElement(s.skill) + sElement(s.style) + `---\n\n`;

  // 5. ギャップ分析
  md += `## 5. ハードとソフトのギャップ分析\n\n`;
  const gaps = result.gaps || [];
  if (!gaps.length) {
    md += `> （ギャップの記載なし）\n\n`;
  } else {
    gaps.forEach((g, i) => {
      md += `> **ギャップ${i + 1}：${g.title || '（無題）'}**\n`;
      if (g.description) md += `> ${g.description}\n`;
      md += `\n`;
    });
  }
  md += `---\n\n`;

  // 6. 優先的変革テーマの提言
  const theme = result.theme || {};
  md += `## 6. 優先的変革テーマの提言\n\n`;
  md += `**提言テーマ：「${theme.title || '（テーマの記載なし）'}」**\n\n`;
  if (theme.reason) md += `${theme.reason}\n\n`;
  md += `### 推奨アクション\n\n`;
  const actions = theme.actions || [];
  if (!actions.length) {
    md += `（推奨アクションの記載なし）\n`;
  } else {
    actions.forEach((a, i) => {
      md += `${i + 1}. **${a.title || 'アクション' + (i + 1)}**: ${a.description || ''}\n`;
    });
  }
  md += `\n---\n\n`;

  // 7. 参照資料
  md += `## 7. 参照資料\n\n`;
  const refs = result.references || [];
  if (!refs.length) {
    md += `- （参照資料の記載なし）\n`;
  } else {
    for (const r of refs) {
      if (r.url) md += `- ${r.title || r.url}: ${r.url}\n`;
      else md += `- ${r.title}\n`;
    }
  }
  if (meta.sourceNote) md += `\n> 注記: ${meta.sourceNote}\n`;
  md += `\n---\n\n`;
  md += `*本診断は公開情報に基づく AI による自動分析であり、内容の正確性を保証するものではありません。診断エンジン: Claude (Anthropic API)。株式会社コミクス*\n`;
  return md;
}

function downloadMarkdown() {
  if (!currentReport) return;
  const md = buildMarkdown(currentReport.result, currentReport.job);
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '7s_report_' + (currentReport.job.id || 'report') + '.md';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- 履歴（localStorage） -----------------------------------------------
function loadHistory() {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_HISTORY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}
function saveHistory(item) {
  let arr = loadHistory().filter((x) => x.id !== item.id);
  arr.unshift(item);
  arr = arr.slice(0, 30);
  localStorage.setItem(LS_HISTORY, JSON.stringify(arr));
}
function renderHistory() {
  const arr = loadHistory();
  if (!arr.length) { el.history.hidden = true; return; }
  el.history.hidden = false;
  el.histList.innerHTML = arr.map((x) => {
    const label = x.companyName || x.url;
    return `<div class="hist-item" data-id="${esc(x.id)}">
      <span class="hs done">${esc(x.date || '')}</span>
      <span class="hc">${esc(label)}</span>
      <span class="hu">${esc(x.url)}</span>
    </div>`;
  }).join('');
  el.histList.querySelectorAll('.hist-item').forEach((node) => {
    node.addEventListener('click', async () => {
      if (notDeployed()) return;
      el.errorBox.hidden = true;
      try {
        const job = await (await fetch(API + '?fn=status&id=' + encodeURIComponent(node.dataset.id))).json();
        if (job && !job.error && job.status === 'done') {
          renderReport(job);
        } else if (job && job.status && job.status !== 'done') {
          showError('この診断はまだ完了していません（状態: ' + esc(job.phase || job.status) + '）', '');
        } else {
          showError('この診断の結果は取得できませんでした（保存期間切れの可能性があります）', '');
        }
      } catch (_) { /* noop */ }
    });
  });
}
