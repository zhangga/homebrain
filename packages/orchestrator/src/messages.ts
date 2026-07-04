/**
 * Canned copy for the orchestrator (kept out of runtime.ts so wording is easy to
 * tweak). Two pieces the plan calls out explicitly:
 *   - GROUP_ADDED_NOTICE (Q4/Q6): the one-time message sent when the bot joins a
 *     group, disclosing that it learns from the group and how to retract.
 *   - coldStartNote (Q3): the honest nudge appended when answering from general
 *     knowledge while the space's knowledge base is still empty.
 */

export const GROUP_ADDED_NOTICE = [
  "大家好，我是 homebrain 🧠。",
  "我会学习本群里分享的知识，用于以后回答大家的问题（@我 即可提问）。",
  "如果某条消息不希望我记录，回复时 @我 说「别记这条」即可撤回。",
].join("\n");

export function coldStartNote(): string {
  return [
    "（目前这个空间的知识库还是空的，所以上面是我的一般性回答。",
    "把值得记住的事发到群里、或 @我 直接告诉我，我就会逐步建立我们的知识库。）",
  ].join("");
}
