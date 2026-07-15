import type { LarkProvisioningState } from "@homebrain/shared";
import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

const ACTIVE_STATES = new Set<LarkProvisioningState>([
  "starting",
  "waiting_for_user",
  "verifying",
]);
const TERMINAL_STATES = new Set<LarkProvisioningState>(["ready", "failed", "expired"]);

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
  return html`<script>
    (function poll() {
      fetch("/setup/feishu/session", { cache:"no-store" })
        .then(function (response) { return response.json(); })
        .then(function (session) {
          if (["ready","failed","expired"].includes(session.state)) location.reload();
          else setTimeout(poll, 1500);
        })
        .catch(function () { setTimeout(poll, 2500); });
    })();
  </script>`;
}
