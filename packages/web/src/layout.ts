/**
 * Server-rendered HTML views for the read-only backend (plan §V). We use Hono's
 * `html` tagged-template helper rather than JSX: it needs no transform config,
 * auto-escapes interpolations (XSS-safe by default), and keeps these views as
 * plain functions. The backend is strictly read-only (MVP), so there are no
 * forms that mutate — only navigation and a question-test box that calls ask().
 */
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

const STYLE = `
  :root { --fg:#1a1a1a; --muted:#666; --bg:#fafafa; --card:#fff; --border:#e2e2e2; --accent:#2563eb; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
         margin:0; color:var(--fg); background:var(--bg); line-height:1.5; }
  header { background:var(--card); border-bottom:1px solid var(--border); padding:12px 20px; }
  header a { color:var(--accent); text-decoration:none; font-weight:600; }
  header .crumbs { color:var(--muted); font-size:14px; }
  main { max-width: 960px; margin: 0 auto; padding: 20px; }
  h1 { font-size:22px; margin:0 0 16px; }
  h2 { font-size:17px; margin:24px 0 10px; }
  table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--border); border-radius:8px; overflow:hidden; }
  th, td { text-align:left; padding:8px 12px; border-bottom:1px solid var(--border); font-size:14px; vertical-align:top; }
  th { background:#f4f4f5; color:var(--muted); font-weight:600; }
  tr:last-child td { border-bottom:none; }
  a { color:var(--accent); }
  .card { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:16px; margin-bottom:16px; }
  .muted { color:var(--muted); font-size:13px; }
  .tag { display:inline-block; background:#eef2ff; color:var(--accent); border-radius:4px; padding:1px 7px; font-size:12px; margin-right:4px; }
  pre { background:#0f172a; color:#e2e8f0; padding:14px; border-radius:8px; overflow:auto; font-size:13px; }
  .content { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:16px; white-space:pre-wrap; font-family:ui-monospace, monospace; font-size:13px; }
  form { display:flex; gap:8px; margin:12px 0; }
  input[type=text] { flex:1; padding:8px 12px; border:1px solid var(--border); border-radius:6px; font-size:14px; }
  button { background:var(--accent); color:#fff; border:none; border-radius:6px; padding:8px 16px; font-size:14px; cursor:pointer; }
  .badge { font-size:12px; padding:2px 8px; border-radius:10px; }
  .badge.knowledge { background:#dcfce7; color:#166534; }
  .badge.general { background:#fef3c7; color:#92400e; }
  .empty { color:var(--muted); padding:24px; text-align:center; }
`;

export interface Crumb {
  label: string;
  href?: string;
}

/** Page shell with a nav header and breadcrumb trail. */
export function layout(
  title: string,
  crumbs: Crumb[],
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const trail = crumbs.map((c, i) => {
    const sep = i > 0 ? " / " : "";
    return c.href
      ? html`${raw(sep)}<a href="${c.href}">${c.label}</a>`
      : html`${raw(sep)}<span>${c.label}</span>`;
  });
  return html`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title} · homebrain</title>
    <style>${raw(STYLE)}</style>
  </head>
  <body>
    <header>
      <a href="/">🧠 homebrain</a>
      <span class="crumbs"> &nbsp;·&nbsp; ${trail}</span>
    </header>
    <main>${body}</main>
  </body>
</html>`;
}
