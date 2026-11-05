import type { Gate, GateKind } from "./types.js";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const KIND_LABEL: Record<GateKind, string> = {
  approve_approach: "Approve approach",
  visual_signoff: "Visual sign-off",
  code_review: "Code review",
  pr_review: "PR review",
  merge_deploy: "Merge + deploy",
  login_credential: "Login / credential",
  product_decision: "Product decision",
  triage_decision: "Triage decision",
};

export interface BoardMeta {
  /** Open-gate cap from the capacity governor, for the header readout. */
  maxOpenGates: number;
  /** Generated-at label. */
  generatedAt: string;
}

function renderImages(gate: Gate): string {
  if (gate.images.length === 0) return "";
  const cells = gate.images
    .map(
      img => `
      <figure class="shot">
        <figcaption>${esc(img.label)}</figcaption>
        <a href="${esc(img.url)}" target="_blank" rel="noopener"><img src="${esc(img.url)}" alt="${esc(img.label)}" loading="lazy"></a>
      </figure>`,
    )
    .join("");
  return `<div class="shots">${cells}</div>`;
}

function renderLinks(gate: Gate): string {
  if (gate.links.length === 0) return "";
  const items = gate.links
    .map(l => `<a class="link" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`)
    .join("");
  return `<div class="links">${items}</div>`;
}

function renderActions(gate: Gate): string {
  const needsNote = gate.actions.some(a => a.kind === "reject" || a.kind === "neutral");
  const note = needsNote
    ? `<textarea class="note" id="note-${gate.id}" placeholder="Optional note (sent with a redirect / send-back)"></textarea>`
    : "";
  const buttons = gate.actions
    .map(
      a =>
        `<button class="btn ${a.primary ? "primary" : ""} ${a.kind}" data-gate="${gate.id}" data-action="${esc(a.id)}">${esc(a.label)}</button>`,
    )
    .join("");
  return `${note}<div class="actions">${buttons}</div>`;
}

function renderCard(gate: Gate): string {
  const issue = gate.issueIdentifier ? `<span class="issue">${esc(gate.issueIdentifier)}</span>` : "";
  const question = gate.question ? `<p class="question">${esc(gate.question)}</p>` : "";
  const est = `~${gate.estimateMinutes} min`;
  return `
  <article class="card" id="card-${gate.id}">
    <header>
      <span class="kind kind-${gate.kind}">${esc(KIND_LABEL[gate.kind])}</span>
      ${issue}
      <span class="est">${est}</span>
    </header>
    <h2>${esc(gate.title)}</h2>
    <p class="summary">${esc(gate.summary)}</p>
    ${question}
    ${renderImages(gate)}
    ${renderLinks(gate)}
    ${renderActions(gate)}
    <p class="err" id="err-${gate.id}"></p>
  </article>`;
}

const STYLE = `
:root { color-scheme: light dark; --bg:#0f1115; --card:#1a1d24; --fg:#e6e8eb; --muted:#9aa3ad; --line:#2a2f3a;
  --approve:#2ea043; --reject:#d1685a; --neutral:#4b7bec; --accent:#6c8cff; }
@media (prefers-color-scheme: light) { :root { --bg:#f4f5f7; --card:#fff; --fg:#1a1d24; --muted:#5b6672; --line:#e3e6ea; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
header.top { position:sticky; top:0; background:var(--bg); border-bottom:1px solid var(--line); padding:14px 20px; display:flex; gap:16px; align-items:baseline; flex-wrap:wrap; z-index:5; }
header.top h1 { font-size:17px; margin:0; }
header.top .stat { color:var(--muted); font-size:13px; }
header.top .stat b { color:var(--fg); }
main { max-width:1100px; margin:0 auto; padding:20px; display:grid; gap:16px; grid-template-columns:repeat(auto-fill,minmax(420px,1fr)); }
@media (max-width:520px){ main{ grid-template-columns:1fr; padding:16px; } }
.card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; }
.card header { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:8px; }
.card h2 { font-size:16px; margin:4px 0 6px; }
.kind { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.4px; padding:2px 8px; border-radius:999px; background:var(--line); color:var(--muted); }
.issue { font-size:12px; color:var(--accent); font-weight:600; }
.est { margin-left:auto; font-size:12px; color:var(--muted); }
.summary { color:var(--fg); margin:0 0 8px; }
.question { font-weight:600; margin:0 0 10px; }
.shots { display:flex; gap:10px; margin:10px 0; flex-wrap:wrap; }
.shot { margin:0; flex:1 1 180px; }
.shot figcaption { font-size:12px; color:var(--muted); margin-bottom:4px; }
.shot img { width:100%; border:1px solid var(--line); border-radius:8px; display:block; }
.links { display:flex; gap:12px; flex-wrap:wrap; margin:8px 0; }
.link { font-size:13px; color:var(--accent); text-decoration:none; }
.note { width:100%; min-height:48px; margin:8px 0; background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:8px; padding:8px; font:inherit; resize:vertical; }
.actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:4px; }
.btn { border:1px solid var(--line); background:var(--bg); color:var(--fg); padding:8px 16px; border-radius:8px; font:inherit; font-weight:600; cursor:pointer; }
.btn.primary.approve { background:var(--approve); border-color:var(--approve); color:#fff; }
.btn.primary.reject { background:var(--reject); border-color:var(--reject); color:#fff; }
.btn.primary.neutral { background:var(--neutral); border-color:var(--neutral); color:#fff; }
.btn:disabled { opacity:.5; cursor:default; }
.err { color:var(--reject); font-size:13px; margin:8px 0 0; min-height:0; }
.empty { color:var(--muted); text-align:center; padding:60px 20px; grid-column:1/-1; }
`;

const SCRIPT = `
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.btn');
  if (!btn) return;
  const id = btn.dataset.gate, action = btn.dataset.action;
  const card = document.getElementById('card-' + id);
  const errEl = document.getElementById('err-' + id);
  const noteEl = document.getElementById('note-' + id);
  const note = noteEl ? noteEl.value : '';
  card.querySelectorAll('.btn').forEach(b => b.disabled = true);
  errEl.textContent = '';
  try {
    const res = await fetch('/gates/' + id + '/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionId: action, note }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    card.style.transition = 'opacity .2s'; card.style.opacity = '0';
    setTimeout(() => { card.remove(); if (!document.querySelector('.card')) location.reload(); }, 220);
  } catch (err) {
    errEl.textContent = 'Could not record decision: ' + err.message;
    card.querySelectorAll('.btn').forEach(b => b.disabled = false);
  }
});
`;

/** Render the full gate board page. Pure — no I/O. */
export function renderBoard(gates: Gate[], meta: BoardMeta): string {
  const open = gates.filter(g => g.status === "open");
  const totalMin = open.reduce((n, g) => n + g.estimateMinutes, 0);
  const cards = open.length
    ? open.map(renderCard).join("\n")
    : `<p class="empty">Nothing waiting on you. 🎉</p>`;
  const over = open.length > meta.maxOpenGates ? " over" : "";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Symphony — your gate queue</title>
<style>${STYLE}</style>
</head><body>
<header class="top">
  <h1>Your gate queue</h1>
  <span class="stat"><b class="${over}">${open.length}</b> / ${meta.maxOpenGates} open</span>
  <span class="stat">~<b>${totalMin}</b> min to clear</span>
  <span class="stat">updated ${esc(meta.generatedAt)}</span>
</header>
<main>${cards}</main>
<script>${SCRIPT}</script>
</body></html>`;
}

/**
 * Build the batched "what needs you" Slack digest. Returns null when nothing is
 * open (so the caller can skip posting). `boardUrl` deep-links to the local board.
 */
export function buildGateDigest(
  gates: Gate[],
  boardUrl: string,
): { text: string; blocks: Array<Record<string, unknown>> } | null {
  const open = gates.filter(g => g.status === "open");
  if (open.length === 0) return null;

  const totalMin = open.reduce((n, g) => n + g.estimateMinutes, 0);
  const lines = open
    .map(g => {
      const issue = g.issueIdentifier ? `${g.issueIdentifier} · ` : "";
      const link = g.links[0]?.url ?? boardUrl;
      return `• *${KIND_LABEL[g.kind]}* — ${issue}<${link}|${g.title}>`;
    })
    .join("\n");

  const text =
    `:hourglass_flowing_sand: *${open.length} decision${open.length === 1 ? "" : "s"} waiting* (~${totalMin} min)\n` +
    `${lines}\n\n<${boardUrl}|Open your gate board →>`;

  return {
    text,
    blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
  };
}
