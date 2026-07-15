/**
 * Individual page bodies for the management backend. Each is a pure function of
 * data already loaded by the routes, returning an html fragment for `layout`.
 * Auto-escaping is on by default (hono/html); `raw()` is used only for trusted
 * static markup. Mutating pages render POST forms.
 */
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type {
  AskResult,
  PageRef,
  RawRecord,
  SpaceId,
  Page,
  SystemHealthSnapshot,
  LarkProvisioningSession,
  LarkSetupStatus,
} from "@homebrain/shared";
import type { SpaceMeta, Agent, Task } from "@homebrain/core";
import { AGENT_PERMISSIONS, TASK_CADENCES } from "@homebrain/core";
import { codexReasoningEffortsForModel, type DetectedProvider } from "@homebrain/llm";
import type { FeishuRuntimeStatus } from "./integrations.ts";
import type { FeishuExternalSharingStatus } from "./external-sharing.ts";
import {
  feishuProvisioningPollScript,
  isFeishuProvisioningActive,
  isFeishuProvisioningFailure,
} from "./feishu-provisioning-view.ts";
import { safeLarkVerificationUrl } from "./verification-url.ts";

const SINGLETON = new Set(["index", "overview", "log", "glossary"]);

function fmtTime(ms?: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

function flash(msg?: string): HtmlEscapedString | Promise<HtmlEscapedString> | string {
  return msg ? html`<div class="flash">${msg}</div>` : "";
}

/** A friendly label for a space: its display name, else the id. */
function spaceLabel(meta: SpaceMeta): string {
  return meta.name?.trim() || meta.id;
}

// ---- spaces / knowledge (adapted from the read-only viewer) ----------------

export function spaceListView(
  spaces: { meta: SpaceMeta; pages: number; pending: number }[],
): HtmlEscapedString | Promise<HtmlEscapedString> {
  if (spaces.length === 0) {
    return html`<h1>空间 / 知识</h1>
      <div class="empty">还没有任何空间。把机器人加入飞书群或私聊它即可创建。</div>`;
  }
  const rows = spaces.map(
    (s) => html`<tr>
      <td><a href="/spaces/${encodeURIComponent(s.meta.id)}">${spaceLabel(s.meta)}</a>
        <div class="muted">${s.meta.id}</div></td>
      <td>${s.pages}</td>
      <td>${s.pending}</td>
      <td class="muted">${fmtTime(s.meta.lastDreamAt)}</td>
    </tr>`,
  );
  return html`<h1>空间 / 知识</h1>
    <p class="subtitle">每个飞书群或私聊对应一个知识空间。</p>
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
  const isTeam = space.startsWith("team/");
  const pageRows = content.length
    ? content.map(
        (p) => html`<tr>
          <td><a href="/spaces/${enc}/pages/${encodeURIComponent(p.slug)}">${p.title}</a></td>
          <td><span class="tag">${p.type}</span></td>
          <td class="muted">${p.summary}</td>
        </tr>`,
      )
    : [html`<tr><td colspan="3" class="empty">暂无知识页，运行提炼后生成。</td></tr>`];

  const groupSettingsLink = isTeam
    ? html` · <a href="/integrations">群设置</a>`
    : "";

  return html`<h1>${meta ? spaceLabel(meta) : space}</h1>
    <p class="subtitle">${space}</p>
    <div class="card">
      <div class="muted">绑定群：${meta?.chatId ?? "—"} · 上次提炼：${fmtTime(meta?.lastDreamAt)}</div>
      <div style="margin-top:10px" class="actions">
        <a href="/spaces/${enc}/raw">原始条目（${rawCount}）</a> ·
        <a href="/spaces/${enc}/ask">问答测试</a>${groupSettingsLink} ·
        <form method="post" action="/spaces/${enc}/dream" class="inline-form">
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
    <div class="contentbox">${page.content}</div>`;
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
      <div class="contentbox" style="margin-top:10px">${result.answer}</div>
      ${cites}
    </div>`;
  }
  return html`<h1>问答测试 · ${space}</h1>
    <form method="get" action="/spaces/${enc}/ask" class="actions">
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

// ---- runtime health -------------------------------------------------------

export function healthView(
  snapshot: SystemHealthSnapshot,
  flashMsg?: string,
  serviceRestartable = false,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const labels: Record<string, string> = {
    knowledge: "知识存储",
    providers: "本机 CLI",
    feishu: "飞书事件消费者",
    dreamCycles: "Dream Cycle",
    tasks: "任务执行",
    dreamScheduler: "Dream Cycle 调度器",
    taskScheduler: "任务调度器",
    service: "后台服务",
  };
  const rows = Object.entries(snapshot.components).map(([key, component]) => {
    const serviceDetails = key === "service" ? component.details : undefined;
    const serviceControls = serviceDetails
      ? html`<div class="row" style="margin-top:12px">
          <span class="muted">PID：${String(serviceDetails.pid ?? "—")} · 启动时间：${fmtTime(
            typeof serviceDetails.startedAt === "number" ? serviceDetails.startedAt : undefined,
          )}</span>
          ${serviceRestartable && serviceDetails.managed === true
            ? html`<form method="post" action="/service/restart" class="inline-form"
                onsubmit="return confirm('安全重启 homebrain 后台服务？')">
                <button type="submit" class="secondary">安全重启</button>
              </form>`
            : ""}
        </div>`
      : "";
    const details = component.details
      ? html`<details><summary class="muted">查看详情</summary><pre>${raw(
          escapePre(JSON.stringify(component.details, null, 2)),
        )}</pre></details>`
      : "";
    return html`<div class="card">
      <div class="row">
        <strong>${labels[key] ?? key}</strong>
        <span class="badge ${component.status}">${component.status}</span>
      </div>
      <div style="margin-top:8px">${component.summary}</div>
      ${serviceControls}
      ${details}
    </div>`;
  });
  return html`<h1>运行状态</h1>
    <p class="subtitle">检查时间：${fmtTime(snapshot.checkedAt)} · Ready：${snapshot.ready ? "是" : "否"}</p>
    ${flash(flashMsg)}
    <div class="card">
      <div class="row">
        <strong>总体状态</strong>
        <span class="badge ${snapshot.status}">${snapshot.status}</span>
      </div>
    </div>
    ${rows}`;
}

// ---- data governance -----------------------------------------------------

export interface GovernanceSpaceSummary {
  meta: SpaceMeta;
  pages: number;
  raw: number;
  pending: number;
  tasks: number;
}

export function governanceView(
  spaces: GovernanceSpaceSummary[],
  retentionDays: number,
  flashMsg?: string,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const rows = spaces.length === 0
    ? html`<tr><td colspan="6" class="empty">暂无空间</td></tr>`
    : spaces.map(({ meta, pages, raw: rawCount, pending, tasks }) => html`<tr>
        <td><strong>${meta.name || meta.id}</strong><div class="muted">${meta.id}</div></td>
        <td>${pages}</td>
        <td>${rawCount}</td>
        <td>${pending}</td>
        <td>${tasks}</td>
        <td>
          <div class="actions">
            <a class="btn secondary" href="/spaces/${encodeURIComponent(meta.id)}/export">导出</a>
            <form method="post" action="/spaces/${encodeURIComponent(meta.id)}/delete" class="inline-form"
              onsubmit="return confirm('永久删除该空间的知识、原始记录和任务？请先导出备份。后续新消息可能重新创建空空间。')">
              <button type="submit" class="danger">删除</button>
            </form>
          </div>
        </td>
      </tr>`);
  return html`<h1>数据治理</h1>
    <p class="subtitle">导出版本化 JSON 备份、恢复空间，或永久删除空间数据。</p>
    ${flash(flashMsg)}
    <div class="card">
      <h2 style="margin-top:0">原始消息保留</h2>
      <p class="muted">当前策略：${retentionDays === 0 ? "永久保留" : `已提炼的消息正文保留 ${retentionDays} 天`}。待提炼消息和文档不会被删除。</p>
      <form method="post" action="/governance/prune" class="actions"
        onsubmit="return confirm('按当前保留周期立即清理已提炼的过期消息？')">
        <button type="submit" class="secondary">立即清理</button>
      </form>
    </div>
    <div class="card">
      <h2 style="margin-top:0">恢复空间</h2>
      <p class="muted">仅接受 homebrain.space v1 归档；已有同名空间不会被覆盖。</p>
      <form method="post" action="/governance/restore" enctype="multipart/form-data" class="actions">
        <input type="file" name="archive" accept="application/json,.json" required />
        <button type="submit">上传并恢复</button>
      </form>
    </div>
    <h2>空间数据</h2>
    <table>
      <thead><tr><th>空间</th><th>知识页</th><th>原始记录</th><th>待提炼</th><th>任务</th><th>操作</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ---- Agents (mew two-pane: list + editor) ----------------------------------

/** Agents page: list column + right editor. `selected` is the agent being edited (or null = new). */
export function agentsView(
  agents: Agent[],
  selected: Agent | null,
  providers: DetectedProvider[],
  models: Record<string, string[]>,
  flashMsg?: string,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const listItems = agents.map((a) => {
    const active = selected && a.id === selected.id;
    return html`<a class="item ${active ? "active" : ""}" href="/agents/${encodeURIComponent(a.id)}">
      <div class="name"><span class="dot"></span>${a.name}</div>
      <div class="sub">${a.provider} / ${a.model || "默认模型"}</div>
    </a>`;
  });
  const newActive = selected === null ? "active" : "";

  const editing = selected;
  const formAction = editing ? `/agents/${encodeURIComponent(editing.id)}` : "/agents";
  const submitLabel = editing ? "保存" : "创建";
  const nameVal = editing?.name ?? "";
  const instrVal = editing?.instruction ?? "";
  const modelVal = editing?.model ?? "";
  const reasoningEffortVal = editing?.reasoningEffort ?? "";
  const providerVal = editing?.provider ?? providers.find((p) => p.available)?.id ?? "claude";
  const visVal = editing?.visibility ?? "Team";
  // Reserved task-execution fields (not consumed by ask/dream yet).
  const workdirVal = editing?.workdir ?? "";
  const permVal = editing?.permission ?? "read-only";
  const skillsVal = (editing?.skills ?? []).join(", ");
  const permLabels: Record<string, string> = { "read-only": "只读", write: "可写", full: "完全访问" };
  const reasoningEffortLabels: Record<string, string> = {
    none: "无（None）",
    low: "低（Low）",
    medium: "中（Medium）",
    high: "高（High）",
    xhigh: "超高（Extra High）",
    max: "最大（Max）",
  };

  // Provider dropdown: only local CLIs, selectable when detected as runnable,
  // else greyed with the reason. (The internal API is used by the claude CLI
  // itself, not exposed as a homebrain provider.)
  const availableList = providers.filter((p) => p.available).map((p) => p.name).join("、");
  const providerOptions = providers.map((p) => {
    const sel = p.id === providerVal ? "selected" : "";
    const disabled = p.available ? "" : "disabled";
    const suffix = p.available ? `（${p.detail}）` : `（不可用：${p.detail}）`;
    return html`<option value="${p.id}" ${sel} ${disabled}>${p.name}${suffix}</option>`;
  });

  // Model options for the initially-selected provider (server-rendered); the
  // client script below repopulates them whenever Provider changes (mew shows a
  // different model list per provider).
  const initialModels = models[providerVal] ?? [];
  const modelOpts = [
    html`<option value="" ${modelVal === "" ? "selected" : ""}>（使用全局默认）</option>`,
    ...initialModels.map((m) => html`<option value="${m}" ${m === modelVal ? "selected" : ""}>${m}</option>`),
  ];
  if (modelVal && !initialModels.includes(modelVal)) {
    modelOpts.push(html`<option value="${modelVal}" selected>${modelVal}（自定义）</option>`);
  }
  const reasoningModels = [...new Set(["", ...(models.codex ?? [])])];
  const reasoningCatalog = Object.fromEntries(
    reasoningModels.map((model) => [model, codexReasoningEffortsForModel(model || undefined)]),
  );
  const initialReasoningEfforts = providerVal === "codex"
    ? codexReasoningEffortsForModel(modelVal || undefined)
    : [];

  // A tiny client script: on provider change, rebuild the Model <select> from
  // the embedded catalog. No framework — plain DOM.
  const catalogJson = JSON.stringify(models);
  const reasoningCatalogJson = JSON.stringify(reasoningCatalog);
  const reasoningLabelsJson = JSON.stringify(reasoningEffortLabels);
  const modelScript = raw(`<script>
(function(){
  var CATALOG = ${catalogJson};
  var REASONING = ${reasoningCatalogJson};
  var REASONING_LABELS = ${reasoningLabelsJson};
  var prov = document.getElementById('agent-provider');
  var model = document.getElementById('agent-model');
  var reasoning = document.getElementById('agent-reasoning-effort');
  if (!prov || !model || !reasoning) return;
  function syncReasoning(){
    var current = reasoning.value;
    reasoning.disabled = prov.value !== 'codex';
    reasoning.innerHTML = '';
    var inherited = document.createElement('option');
    inherited.value = ''; inherited.textContent = '默认（继承 Codex 配置）';
    reasoning.appendChild(inherited);
    if (reasoning.disabled) return;
    var list = REASONING[model.value] || REASONING[''] || [];
    list.forEach(function(effort){
      var option = document.createElement('option');
      option.value = effort; option.textContent = REASONING_LABELS[effort] || effort;
      if (effort === current) option.selected = true;
      reasoning.appendChild(option);
    });
  }
  prov.addEventListener('change', function(){
    var list = CATALOG[prov.value] || [];
    var cur = model.value;
    model.innerHTML = '';
    var def = document.createElement('option');
    def.value = ''; def.textContent = '（使用全局默认）';
    model.appendChild(def);
    list.forEach(function(m){
      var o = document.createElement('option');
      o.value = m; o.textContent = m;
      if (m === cur) o.selected = true;
      model.appendChild(o);
    });
    syncReasoning();
  });
  model.addEventListener('change', syncReasoning);
  syncReasoning();
})();
</script>`);

  const deleteForm = editing
    ? html`<form method="post" action="/agents/${encodeURIComponent(editing.id)}/delete" class="inline-form"
        onsubmit="return confirm('删除该 Agent？已指定它的群将回退到默认。')">
        <button type="submit" class="danger">删除</button>
      </form>`
    : "";

  return html`<h1>Agents</h1>
    <p class="subtitle">配置回答用的智能体：Provider（执行后端）、人格（Instruction）与模型。可在 Integrations 里给每个群指定 Agent。</p>
    <div class="split">
      <div class="listcol">
        <a class="item ${newActive}" href="/agents"><div class="name">＋ 新建 Agent</div>
          <div class="sub">创建一个新的回答智能体</div></a>
        ${listItems}
      </div>
      <div>
        ${flash(flashMsg)}
        <form method="post" action="${formAction}" class="stack card">
          <div class="field">
            <label>名称</label>
            <input type="text" name="name" value="${nameVal}" placeholder="例如：知识助手" required />
          </div>
          <div class="field">
            <label>Instruction <span class="hint">（人格 / 额外系统提示，会注入到回答中）</span></label>
            <textarea name="instruction" placeholder="描述这个 agent 的语气、角色与回答风格…">${instrVal}</textarea>
          </div>
          <div class="grid2">
            <div class="field">
              <label>Provider <span class="hint">本机已检测：${availableList || "无（未装 CLI）"}</span></label>
              <select name="provider" id="agent-provider">
                ${providerOptions}
              </select>
            </div>
            <div class="field">
              <label>Model <span class="hint">随 Provider 变化</span></label>
              <select name="model" id="agent-model">
                ${modelOpts}
              </select>
            </div>
            <div class="field">
              <label>推理强度 <span class="hint">仅 Codex；档位随模型变化，级别越高通常越慢</span></label>
              <select name="reasoningEffort" id="agent-reasoning-effort" ${providerVal === "codex" ? "" : "disabled"}>
                <option value="" ${reasoningEffortVal === "" ? "selected" : ""}>默认（继承 Codex 配置）</option>
                ${initialReasoningEfforts.map(
                  (effort) => html`<option value="${effort}" ${effort === reasoningEffortVal ? "selected" : ""}>${reasoningEffortLabels[effort] ?? effort}</option>`,
                )}
              </select>
            </div>
            <div class="field">
              <label>Visibility</label>
              <select name="visibility">
                ${["Team", "Personal"].map(
                  (v) => html`<option value="${v}" ${v === visVal ? "selected" : ""}>${v}</option>`,
                )}
              </select>
            </div>
            <div class="field">
              <label>Permission <span class="hint">任务执行权限 · 尚未生效</span></label>
              <select name="permission">
                ${AGENT_PERMISSIONS.map(
                  (p) => html`<option value="${p}" ${p === permVal ? "selected" : ""}>${permLabels[p] ?? p}</option>`,
                )}
              </select>
            </div>
          </div>
          <h2 style="font-size:14px;margin:18px 0 4px">任务执行 <span class="hint" style="font-weight:400">（为学习任务 / 待办等预留，暂未接入 —— 目前问答与提炼不使用以下字段）</span></h2>
          <div class="grid2">
            <div class="field">
              <label>Workdir <span class="hint">CLI 执行任务的工作目录</span></label>
              <input type="text" name="workdir" value="${workdirVal}" placeholder="~/work/项目目录" />
            </div>
            <div class="field">
              <label>Skills <span class="hint">逗号分隔，预留</span></label>
              <input type="text" name="skills" value="${skillsVal}" placeholder="例如：code-review, web-search" />
            </div>
          </div>
          <div class="actions">
            <button type="submit">${submitLabel}</button>
            ${deleteForm}
          </div>
        </form>
      </div>
    </div>
    ${modelScript}`;
}

// ---- Tasks (research task execution) ---------------------------------------

const CADENCE_LABELS: Record<string, string> = { hourly: "每小时", daily: "每天" };

/** Tasks page: list column + right editor. `selected` is the task being edited (or null = new). */
export function tasksView(
  tasks: Task[],
  selected: Task | null,
  spaces: SpaceMeta[],
  flashMsg?: string,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const statusBadge = (t: Task) => {
    if (!t.lastStatus) return html`<span class="muted">未运行</span>`;
    return t.lastStatus === "ok"
      ? html`<span class="badge knowledge">成功</span>`
      : html`<span class="badge general">失败</span>`;
  };
  const listItems = tasks.map((t) => {
    const active = selected && t.id === selected.id;
    const cad = CADENCE_LABELS[t.cadence] ?? t.cadence;
    return html`<a class="item ${active ? "active" : ""}" href="/tasks/${encodeURIComponent(t.id)}">
      <div class="name"><span class="dot" style="${t.enabled ? "" : "background:#cbd5e1"}"></span>${t.name}</div>
      <div class="sub">${cad}${t.cadence === "daily" ? ` ${t.hour}:00` : ""} · ${t.space}</div>
    </a>`;
  });
  const newActive = selected === null ? "active" : "";

  const editing = selected;
  const formAction = editing ? `/tasks/${encodeURIComponent(editing.id)}` : "/tasks";
  const submitLabel = editing ? "保存" : "创建";
  const nameVal = editing?.name ?? "";
  const topicVal = editing?.topic ?? "";
  const spaceVal = editing?.space ?? spaces[0]?.id ?? "";
  const cadenceVal = editing?.cadence ?? "daily";
  const hourVal = editing?.hour ?? 8;
  const enabledOn = editing ? editing.enabled : true;
  const notifyOn = editing ? editing.notify : true;
  const distillOn = editing ? editing.distillOnRun : true;

  const spaceOptions = spaces.length
    ? spaces.map((s) => html`<option value="${s.id}" ${s.id === spaceVal ? "selected" : ""}>${s.name?.trim() || s.id}</option>`)
    : [html`<option value="">（还没有空间，先让机器人进群或私聊）</option>`];

  const deleteForm = editing
    ? html`<form method="post" action="/tasks/${encodeURIComponent(editing.id)}/delete" class="inline-form"
        onsubmit="return confirm('删除该任务？')">
        <button type="submit" class="danger">删除</button>
      </form>`
    : "";
  const runForm = editing
    ? html`<form method="post" action="/tasks/${encodeURIComponent(editing.id)}/run" class="inline-form">
        <button type="submit" class="secondary">立即运行</button>
      </form>`
    : "";

  const lastRun = editing?.lastRunAt
    ? html`<div class="muted" style="margin-top:8px">上次运行：${fmtTime(editing.lastRunAt)} · ${statusBadge(editing)}</div>
        ${editing.lastStatus === "error" && editing.lastError
          ? html`<div class="muted">错误：${editing.lastError.slice(0, 200)}</div>`
          : ""}
        ${editing.lastSummary ? html`<div class="contentbox" style="margin-top:8px">${editing.lastSummary}</div>` : ""}`
    : "";

  return html`<h1>任务</h1>
    <p class="subtitle">让空间的 Agent 定期研究一个主题，结果写入该空间知识库（夜间提炼成页）并可推送到飞书。</p>
    <div class="split">
      <div class="listcol">
        <a class="item ${newActive}" href="/tasks"><div class="name">＋ 新建任务</div>
          <div class="sub">创建一个研究任务</div></a>
        ${listItems}
      </div>
      <div>
        ${flash(flashMsg)}
        <form method="post" action="${formAction}" class="stack card">
          <div class="field">
            <label>名称</label>
            <input type="text" name="name" value="${nameVal}" placeholder="例如：每日 AI 进展" required />
          </div>
          <div class="field">
            <label>研究主题 <span class="hint">交给空间 Agent 的调研提示</span></label>
            <textarea name="topic" placeholder="例如：总结大模型 Agent 领域本周的重要进展与观点">${topicVal}</textarea>
          </div>
          <div class="grid2">
            <div class="field">
              <label>目标空间 <span class="hint">结果写入这里，用其 Agent</span></label>
              <select name="space">${spaceOptions}</select>
            </div>
            <div class="field">
              <label>周期</label>
              <select name="cadence">
                ${TASK_CADENCES.map(
                  (c) => html`<option value="${c}" ${c === cadenceVal ? "selected" : ""}>${CADENCE_LABELS[c] ?? c}</option>`,
                )}
              </select>
            </div>
            <div class="field">
              <label>每天几点 <span class="hint">0-23，仅每天周期用</span></label>
              <input type="number" min="0" max="23" name="hour" value="${hourVal}" />
            </div>
          </div>
          <div class="toggle-row">
            <div><strong>启用</strong><div class="hint">关闭后调度器不会自动运行</div></div>
            <label class="switch"><input type="checkbox" name="enabled" ${enabledOn ? "checked" : ""} /><span class="slider"></span></label>
          </div>
          <div class="toggle-row">
            <div><strong>推送飞书</strong><div class="hint">完成后把摘要发到空间绑定的群/私聊</div></div>
            <label class="switch"><input type="checkbox" name="notify" ${notifyOn ? "checked" : ""} /><span class="slider"></span></label>
          </div>
          <div class="toggle-row">
            <div><strong>完成后立即提炼</strong><div class="hint">运行结束就把结果提炼成知识页（关闭则等夜间提炼）</div></div>
            <label class="switch"><input type="checkbox" name="distillOnRun" ${distillOn ? "checked" : ""} /><span class="slider"></span></label>
          </div>
          ${lastRun}
          <div class="actions">
            <button type="submit">${submitLabel}</button>
            ${runForm}
            ${deleteForm}
          </div>
        </form>
      </div>
    </div>`;
}

// ---- Integrations (mew: Lark bot + Lark groups) ----------------------------
function feishuProvisioningControl(
  setup: LarkSetupStatus,
  provisioning: LarkProvisioningSession,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const url = safeLarkVerificationUrl(provisioning.verificationUrl);
  const active = isFeishuProvisioningActive(provisioning.state);
  if (active) {
    return html`<div class="integration-actions">
      <span class="muted">${provisioning.state === "verifying" ? "正在验证机器人和授权…" : provisioning.message}</span>
      ${url ? html`<a class="btn" href="${url}" target="_blank" rel="noreferrer">打开飞书并确认</a>` : ""}
      ${feishuProvisioningPollScript()}
    </div>`;
  }
  const label = setup.state === "ready" && setup.verified ? "创建并切换机器人" : "一键创建并连接";
  return html`<form method="post" action="/setup/feishu/automatic" class="integration-actions">
    ${isFeishuProvisioningFailure(provisioning.state)
      ? html`<span class="muted">${provisioning.message}</span>`
      : ""}
    <input type="hidden" name="brand" value="feishu" />
    <input type="hidden" name="returnTo" value="/integrations" />
    <button type="submit">${label}</button>
  </form>`;
}

function externalSharingControl(
  sharing: FeishuExternalSharingStatus,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  if (sharing.state === "verified") {
    return html`<div class="integration-actions"><span class="badge ok">对外共享已验证</span><span class="muted">${sharing.verifiedGroupName ?? sharing.verifiedChatId ?? "外部群消息已收到"}</span></div>`;
  }
  if (sharing.state === "awaiting_external_message") {
    return html`<div class="integration-actions"><span class="badge degraded">等待外部群消息</span>${sharing.consoleUrl ? html`<a class="btn secondary" href="${sharing.consoleUrl}" target="_blank" rel="noreferrer">打开飞书应用</a>` : ""}<a class="btn secondary" href="/integrations">重新检查</a></div>`;
  }
  if (sharing.state === "skipped") {
    return html`<div class="integration-actions"><span class="muted">当前仅供企业内部使用</span>
      ${sharing.consoleUrl ? html`<a class="btn secondary" href="${sharing.consoleUrl}" target="_blank" rel="noreferrer">打开飞书应用</a>` : ""}
      <form method="post" action="/setup/feishu/external-sharing/start">
        <input type="hidden" name="returnTo" value="/integrations" />
        <button type="submit" class="secondary">我已提交，开始验证</button>
      </form>
    </div>`;
  }
  return html`<div class="integration-actions">
    ${sharing.consoleUrl ? html`<a class="btn secondary" href="${sharing.consoleUrl}" target="_blank" rel="noreferrer">打开当前飞书应用</a>` : ""}
    <form method="post" action="/setup/feishu/external-sharing/start">
      <input type="hidden" name="returnTo" value="/integrations" />
      <button type="submit">开始对外共享验证</button>
    </form>
  </div>`;
}

export interface IntegrationsViewInput {
  botName: string;
  botOpenId: string;
  setup: LarkSetupStatus;
  provisioning: LarkProvisioningSession;
  restartRequired: boolean;
  runtime?: FeishuRuntimeStatus;
  externalSharing: FeishuExternalSharingStatus;
  groups: SpaceMeta[];
  agents: Agent[];
  flashMsg?: string;
}

export function integrationsView(
  input: IntegrationsViewInput,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const {
    botName,
    botOpenId,
    setup,
    provisioning,
    restartRequired,
    runtime,
    externalSharing,
    groups,
    agents,
    flashMsg,
  } = input;
  const shownBotName = setup.botName ?? botName;
  const shownBotOpenId = setup.botOpenId ?? botOpenId;
  const agentName = (id?: string) => agents.find((a) => a.id === id)?.name;
  const runtimeFailed = runtime?.consumers.some((consumer) => consumer.state === "failed") ?? false;
  const runtimeBadge = restartRequired
    ? html`<span class="badge degraded">需要重启</span>`
    : runtimeFailed
      ? html`<span class="badge down">消息监听异常</span>`
      : runtime?.ready
        ? html`<span class="badge ok">消息监听已就绪</span>`
        : html`<span class="badge degraded">等待连接</span>`;
  const runtimeRecovery = restartRequired
    ? html`<a class="btn secondary" href="/health">前往运行状态重启</a>`
    : runtimeFailed
      ? html`<a class="btn secondary" href="/health">前往运行状态恢复</a>`
      : "";

  const groupCards = groups.length
    ? groups.map((g) => {
        const enc = encodeURIComponent(g.id);
        const assigned = agentName(g.agentId) ?? "默认";
        const replyMode = (g.replyInThread ?? true) ? "Topic reply" : "普通回复";
        const mentionMode = (g.mentionsOnly ?? true) ? "@ mentions only" : "响应全部消息";
        const agentOpts = [
          html`<option value="" ${!g.agentId ? "selected" : ""}>默认（全局）</option>`,
          ...agents.map(
            (a) => html`<option value="${a.id}" ${a.id === g.agentId ? "selected" : ""}>${a.name}</option>`,
          ),
        ];
        return html`<div class="card">
          <div class="row">
            <div>
              <div style="font-weight:600">${spaceLabel(g)}</div>
              <div class="muted">${assigned} · ${replyMode} · ${mentionMode}</div>
              <div class="muted">Bot ${g.chatId ?? g.id}</div>
            </div>
          </div>
          <form method="post" action="/integrations/groups/${enc}" class="stack" style="margin-top:12px">
            <div class="grid2">
              <div class="field">
                <label>群名称</label>
                <input type="text" name="name" value="${g.name ?? ""}" placeholder="${g.id}" />
              </div>
              <div class="field">
                <label>指定 Agent</label>
                <select name="agentId">${agentOpts}</select>
              </div>
            </div>
            <div class="toggle-row">
              <div><strong>Topic reply</strong><div class="hint">在话题/分组内回复（飞书 thread）</div></div>
              <label class="switch"><input type="checkbox" name="replyInThread" ${(g.replyInThread ?? true) ? "checked" : ""} /><span class="slider"></span></label>
            </div>
            <div class="toggle-row">
              <div><strong>@ mentions only</strong><div class="hint">推荐开启；敏感权限已在创建时申请。若企业尚未批准，关闭后可能无法收到全部消息。</div></div>
              <label class="switch"><input type="checkbox" name="mentionsOnly" ${(g.mentionsOnly ?? true) ? "checked" : ""} /><span class="slider"></span></label>
            </div>
            <div class="actions">
              <button type="submit">保存群设置</button>
              <button type="submit" class="secondary" formaction="/integrations/groups/${enc}/test">发送测试消息</button>
            </div>
          </form>
        </div>`;
      })
    : [html`<div class="empty">还没有群空间。把机器人加入飞书群即可出现在这里。</div>`];

  return html`<h1>飞书连接</h1>
    <p class="subtitle">创建机器人、连接群聊，并管理每个群的回答方式。</p>
    ${flash(flashMsg)}

    <section class="card integration-card">
      <div class="integration-row">
        <div>
          <strong>飞书机器人</strong>
          <div class="muted">接收群消息、发送回答，并建立群知识空间。</div>
        </div>
        ${setup.state === "ready" && setup.verified
          ? html`<div class="connection-pill"><span><span class="dot"></span>${shownBotName || "已连接机器人"}</span><span class="muted">${restartRequired ? "待启用" : "当前"}</span></div>`
          : feishuProvisioningControl(setup, provisioning)}
      </div>
      ${setup.state === "ready" && setup.verified ? html`<div class="integration-row">
        <div>
          <strong>${shownBotName || "已连接机器人"}</strong>
          <div class="muted">${setup.appId ?? ""}${shownBotOpenId ? ` · ${shownBotOpenId}` : ""}</div>
        </div>
        ${feishuProvisioningControl(setup, provisioning)}
      </div>` : ""}
      <div class="integration-row">
        <div>
          <strong>飞书群聊</strong>
          <div class="muted">机器人加入群后自动建立对应工作空间。</div>
        </div>
        <div class="integration-actions">${runtimeBadge}${runtimeRecovery}</div>
      </div>
      ${setup.state === "ready" && setup.verified && setup.brand !== "lark" ? html`<div class="integration-row">
        <div>
          <strong>对外共享</strong>
          <div class="muted">允许机器人加入外部群，并接受外部用户私聊。</div>
        </div>
        ${externalSharingControl(externalSharing)}
      </div>` : ""}
      <div class="integration-detail">
        <div class="muted">首次确认会申请完整权限：消息收发、群消息读取、附件、表情、群信息和两条事件订阅。企业管理员可能需要在这次确认中批准敏感权限；上述权限无需事后进入开放平台补配置。手动连接已有应用时仍需自行确认权限。对外共享由飞书限制在版本发布流程中：创建版本时开启“允许机器人被添加到外部群中使用”和“允许外部用户与机器人单聊”，再提交发布并完成管理员审批。</div>
      </div>
    </section>

    <h2>已连接群聊</h2>
    ${groupCards}

    <details class="card">
      <summary style="cursor:pointer;font-weight:600">更多设置</summary>
      <div class="muted" style="margin:10px 0 6px">手动连接已有应用，或重新验证当前 lark-cli 配置。</div>
      <div class="muted" style="margin:0 0 14px">若一键创建未完成，请回到上方重试；只有手动应用缺少配置时，才需要在对应开发者后台补齐权限和事件订阅。</div>
      <form method="post" action="/integrations/bot/setup" class="stack">
        <div class="field">
          <label>应用平台</label>
          <select name="brand"><option value="feishu">飞书</option><option value="lark"${setup.brand === "lark" ? " selected" : ""}>Lark</option></select>
        </div>
        <div class="grid2">
          <div class="field">
            <label>App ID</label>
            <input type="text" name="appId" placeholder="cli_..." required autocomplete="off" />
          </div>
          <div class="field">
            <label>App Secret</label>
            <input type="password" name="appSecret" required autocomplete="new-password" />
          </div>
        </div>
        <div class="actions"><button type="submit" class="secondary">手动连接已有应用</button><button type="submit" class="secondary" formnovalidate formaction="/integrations/bot/verify">只验证现有配置</button></div>
      </form>
    </details>`;
}

// ---- Settings --------------------------------------------------------------

export interface SettingsData {
  defaultProvider: string;
  defaultModel: string;
  dailyBudgetUsd: number;
  dreamHour: number;
  rawRetentionDays: number;
  webPort: number;
}

export function settingsView(
  s: SettingsData,
  providers: DetectedProvider[],
  models: Record<string, string[]>,
  flashMsg?: string,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  // Default provider: only CLIs; available ones selectable, others greyed.
  const providerOptions = providers.map((p) => {
    const sel = p.id === s.defaultProvider ? "selected" : "";
    const disabled = p.available ? "" : "disabled";
    const suffix = p.available ? `（${p.detail}）` : `（不可用：${p.detail}）`;
    return html`<option value="${p.id}" ${sel} ${disabled}>${p.name}${suffix}</option>`;
  });
  const initialModels = models[s.defaultProvider] ?? [];
  const modelOpts = [
    html`<option value="" ${s.defaultModel === "" ? "selected" : ""}>（CLI 自身默认）</option>`,
    ...initialModels.map((m) => html`<option value="${m}" ${m === s.defaultModel ? "selected" : ""}>${m}</option>`),
  ];
  if (s.defaultModel && !initialModels.includes(s.defaultModel)) {
    modelOpts.push(html`<option value="${s.defaultModel}" selected>${s.defaultModel}（自定义）</option>`);
  }
  const catalogJson = JSON.stringify(models);
  const modelScript = raw(`<script>
(function(){
  var CATALOG = ${catalogJson};
  var prov = document.getElementById('default-provider');
  var model = document.getElementById('default-model');
  if (!prov || !model) return;
  prov.addEventListener('change', function(){
    var list = CATALOG[prov.value] || [];
    var cur = model.value;
    model.innerHTML = '';
    var def = document.createElement('option');
    def.value = ''; def.textContent = '（CLI 自身默认）';
    model.appendChild(def);
    list.forEach(function(m){
      var o = document.createElement('option');
      o.value = m; o.textContent = m;
      if (m === cur) o.selected = true;
      model.appendChild(o);
    });
  });
})();
</script>`);

  return html`<h1>设置</h1>
    <p class="subtitle">全局默认配置。默认 Provider / Model、预算、提炼时刻即时生效；端口需重启生效。</p>
    ${flash(flashMsg)}
    <form method="post" action="/settings" class="stack card">
      <h2 style="margin-top:0">默认 Agent（未指定时使用）</h2>
      <div class="grid2">
        <div class="field"><label>默认 Provider <span class="hint">本机 CLI</span></label>
          <select name="defaultProvider" id="default-provider">${providerOptions}</select></div>
        <div class="field"><label>默认 Model <span class="hint">随 Provider 变化</span></label>
          <select name="defaultModel" id="default-model">${modelOpts}</select></div>
      </div>
      <h2>运行</h2>
      <div class="grid2">
        <div class="field"><label>每日预算 (USD) <span class="hint">仅对可计费的 provider 有意义</span></label><input type="number" step="0.01" min="0" name="dailyBudgetUsd" value="${s.dailyBudgetUsd}" /></div>
        <div class="field"><label>提炼时刻 <span class="hint">0-23，Asia/Shanghai</span></label><input type="number" min="0" max="23" name="dreamHour" value="${s.dreamHour}" /></div>
        <div class="field"><label>原始消息保留（天） <span class="hint">0 = 永久保留；仅清理已提炼消息</span></label><input type="number" min="0" max="36500" name="rawRetentionDays" value="${s.rawRetentionDays}" /></div>
        <div class="field"><label>后台端口 <span class="hint">重启生效</span></label><input type="number" min="1" max="65535" name="webPort" value="${s.webPort}" /></div>
      </div>
      <div class="actions"><button type="submit">保存设置</button></div>
    </form>
    ${modelScript}`;
}
