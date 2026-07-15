import type { LarkProvisioningState } from "@homeagent/shared";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

const ACTIVE_STATES = new Set<LarkProvisioningState>([
  "starting",
  "waiting_for_user",
  "verifying",
]);
const TERMINAL_STATE_VALUES = ["ready", "failed", "expired"] as const satisfies readonly LarkProvisioningState[];
const TERMINAL_STATES = new Set<LarkProvisioningState>(TERMINAL_STATE_VALUES);

function safeScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function isFeishuProvisioningActive(state: LarkProvisioningState): boolean {
  return ACTIVE_STATES.has(state);
}

export function isFeishuProvisioningTerminal(state: LarkProvisioningState): boolean {
  return TERMINAL_STATES.has(state);
}

export function isFeishuProvisioningFailure(state: LarkProvisioningState): boolean {
  return isFeishuProvisioningTerminal(state) && state !== "ready";
}

export function feishuProvisioningPollScript(): HtmlEscapedString | Promise<HtmlEscapedString> {
  const terminalStates = raw(safeScriptJson(TERMINAL_STATE_VALUES));
  return html`<script>
    (function poll() {
      const terminalStates = ${terminalStates};
      fetch("/setup/feishu/session", { cache:"no-store" })
        .then(function (response) { return response.json(); })
        .then(function (session) {
          if (terminalStates.includes(session.state)) location.reload();
          else setTimeout(poll, 1500);
        })
        .catch(function () { setTimeout(poll, 2500); });
    })();
  </script>`;
}
