/**
 * Individual page bodies for the read-only backend. Each is a pure function of
 * data already loaded by the routes, returning an html fragment for `layout`.
 */
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { AskResult, Hit, PageRef, RawRecord, SpaceId, Page } from "@homebrain/shared";
import type { SpaceMeta } from "@homebrain/core";

const SINGLETON = new Set(["index", "overview", "log", "glossary"]);

function fmtTime(ms?: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

export function spaceListView(spaces: { meta: SpaceMeta; pages: number; pending: number }[]): HtmlEscapedString | Promise<HtmlEscapedString> {
  if (spaces.length === 0) {
    return html`<h1>空间</h1><div class="empty">还没有任何空间。把机器人加入飞书群或私聊它即可创建。</div>`;
  }
  const rows = spaces.map(
    (s) => html`<tr>
      <td><a href="/spaces/${encodeURIComponent(s.meta.id)}">${s.meta.id}</a></td>
      <td>${s.pages}</td>
      <td>${s.pending}</td>
      <td class="muted">${fmtTime(s.meta.lastDreamAt)}</td>
    </tr>`,
  );
  return html`<h1>空间</h1>
    <table>
      <tr><th>空间</th><th>知识页</th><th>待提炼</th><th>上次提炼</th></tr>
      ${rows}
    </table>`;
}

export function spaceDetailView(
  space: SpaceId,
  pages: PageRef[],
  rawCount: number,
  meta?: SpaceMeta,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const content = pages.filter((p) => !SINGLETON.has(p.slug));
  const enc = encodeURIComponent(space);
  const pageRows = content.length
    ? content.map(
        (p) => html`<tr>
          <td><a href="/spaces/${enc}/pages/${encodeURIComponent(p.slug)}">${p.title}</a></td>
          <td><span class="tag">${p.type}</span></td>
          <td class="muted">${p.summary}</td>
        </tr>`,
      )
    : [html`<tr><td colspan="3" class="empty">暂无知识页，运行提炼后生成。</td></tr>`];

  return html`<h1>${space}</h1>
    <div class="card">
      <div class="muted">绑定群：${meta?.chatId ?? "—"} · 上次提炼：${fmtTime(meta?.lastDreamAt)}</div>
      <div style="margin-top:10px">
        <a href="/spaces/${enc}/raw">原始条目（${rawCount}）</a> ·
        <a href="/spaces/${enc}/ask">问答测试</a> ·
        <form method="post" action="/spaces/${enc}/dream" style="display:inline">
          <button type="submit">手动触发提炼</button>
        </form>
      </div>
    </div>
    <h2>知识页（${content.length}）</h2>
    <table>
      <tr><th>标题</th><th>类型</th><th>摘要</th></tr>
      ${pageRows}
    </table>`;
}

export function pageView(space: SpaceId, page: Page): HtmlEscapedString | Promise<HtmlEscapedString> {
  const enc = encodeURIComponent(space);
  const aliases = page.aliases.length ? html`<div class="muted">别名：${page.aliases.join("、")}</div>` : "";
  const links = page.links.length
    ? html`<div class="muted">链接：${page.links.map(
        (l) => html`<a href="/spaces/${enc}/pages/${encodeURIComponent(l)}">${l}</a> `,
      )}</div>`
    : "";
  const tags = page.tags.map((t) => html`<span class="tag">${t}</span>`);
  return html`<h1>${page.title} <span class="tag">${page.type}</span></h1>
    <div class="card">
      <div class="muted">slug：${page.slug} · 更新：${fmtTime(page.updatedAt)}</div>
      ${aliases}${links}
      <div style="margin-top:8px">${tags}</div>
      <div class="muted" style="margin-top:8px">来源 raw：${page.sources.length ? page.sources.join(", ") : "—"}</div>
    </div>
    <h2>正文</h2>
    <div class="content">${page.content}</div>`;
}

export function rawListView(space: SpaceId, raws: RawRecord[]): HtmlEscapedString | Promise<HtmlEscapedString> {
  const rows = raws.length
    ? raws.map(
        (r) => html`<tr>
          <td class="muted">${fmtTime(r.createdAt)}</td>
          <td><span class="tag">${r.source}</span></td>
          <td>${r.ingested ? "✓" : "…"}</td>
          <td>${r.content.slice(0, 160)}</td>
        </tr>`,
      )
    : [html`<tr><td colspan="4" class="empty">暂无原始条目。</td></tr>`];
  return html`<h1>原始条目 · ${space}</h1>
    <table>
      <tr><th>时间</th><th>来源</th><th>已提炼</th><th>内容</th></tr>
      ${rows}
    </table>`;
}

export function askView(
  space: SpaceId,
  question: string | null,
  result: AskResult | null,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const enc = encodeURIComponent(space);
  let answer: HtmlEscapedString | Promise<HtmlEscapedString> | string = "";
  if (result) {
    const badge = result.source === "knowledge"
      ? html`<span class="badge knowledge">知识库</span>`
      : html`<span class="badge general">通用</span>`;
    const cites = result.citations.length
      ? html`<div class="muted" style="margin-top:8px">引用：${result.citations.map(
          (c) => html`<a href="/spaces/${enc}/pages/${encodeURIComponent(c.slug)}">${c.title}</a> `,
        )}</div>`
      : "";
    answer = html`<div class="card">
      <div>${badge}</div>
      <div class="content" style="margin-top:10px">${result.answer}</div>
      ${cites}
    </div>`;
  }
  return html`<h1>问答测试 · ${space}</h1>
    <form method="get" action="/spaces/${enc}/ask">
      <input type="text" name="q" placeholder="问一个问题…" value="${question ?? ""}" />
      <button type="submit">提问</button>
    </form>
    ${answer}`;
}

export function logsView(logs: { day: string; lines: string[] }[]): HtmlEscapedString | Promise<HtmlEscapedString> {
  if (logs.length === 0) return html`<h1>LLM 调用日志</h1><div class="empty">暂无调用记录。</div>`;
  const blocks = logs.map(
    (l) => html`<h2>${l.day}</h2><pre>${raw(escapePre(l.lines.join("\n")))}</pre>`,
  );
  return html`<h1>LLM 调用日志</h1>${blocks}`;
}

function escapePre(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
