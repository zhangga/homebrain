/**
 * `homebrain repl` — drive the full orchestrator trunk from the terminal using
 * the CLI connector and the REAL gateway (no feishu). This is the Slice 4
 * acceptance harness: "终端模拟飞书跑通全主干".
 *
 * Usage:
 *   bun run packages/app/src/repl.ts
 * Then type messages. Prefixes:
 *   /at <text>     group message that @-mentions the bot (expects a reply)
 *   /group <text>  group message without mention (silent capture)
 *   /added         simulate the bot being added to the group
 *   /dream         run a dream cycle now (distill captured group messages)
 *   plain text     a p2p message (always answered)
 */
import { KnowledgeEngine } from "@homebrain/core";
import { CliConnector } from "@homebrain/connectors";
import { Orchestrator } from "@homebrain/orchestrator";
import { teamSpace, personalSpace } from "@homebrain/shared";

async function main(): Promise<void> {
  const engine = new KnowledgeEngine();
  const userId = "ou_repl_user";
  const groupChatId = "oc_repl_group";

  const connector = new CliConnector({
    interactive: true,
    userId,
    groupChatId,
    async onSlash(cmd) {
      if (cmd === "/dream") {
        // Distill both the group and personal spaces so /at questions can be
        // answered from freshly-built pages.
        for (const space of [teamSpace(groupChatId), personalSpace(userId)]) {
          if (!engine.registry.has(space)) continue;
          process.stdout.write(`\n⏳ dream cycle: ${space} ...\n`);
          const report = await engine.runDreamCycle(space);
          process.stdout.write(
            `✅ ${space}: examined=${report.examined} written=${report.pagesWritten} skipped=${report.skipped}\n\n`,
          );
        }
        return true;
      }
      return false;
    },
  });
  const orch = new Orchestrator({ engine, connector });

  console.error("[homebrain repl] starting — Ctrl-D to exit");
  await orch.start(); // blocks reading stdin in interactive mode
  await orch.stop();
  engine.close();
  console.error("[homebrain repl] bye");
}

main().catch((err) => {
  console.error("repl failed:", err);
  process.exit(1);
});
