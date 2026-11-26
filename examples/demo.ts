// Scripted Claude-style flow against the local mock. Run: npm run demo
// It drives the real MCP server over an in-memory transport, exactly as Claude would.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { pathToFileURL } from "node:url";
import { MockMetaApi } from "../src/mock.js";
import { buildServer } from "../src/server.js";

const money = (c: number) => `A$${(c / 100).toFixed(2)}`;

export async function runDemo(): Promise<string> {
  const api = new MockMetaApi();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer(api).connect(b);
  const client = new Client({ name: "demo", version: "0" });
  await client.connect(a);

  const out: string[] = [];
  const say = (s = "") => out.push(s);
  const call = async (name: string, args: Record<string, unknown>) => {
    say(`Tool call: \`${name}\``);
    say();
    const r: any = await client.callTool({ name, arguments: args });
    return { isError: !!r.isError, data: JSON.parse(r.content[0].text) };
  };

  say("# Demo: launch to 12 accounts, with guardrails");
  say();
  say("Run on the local mock of the Meta Marketing API (30 fictional ad accounts, 3 businesses). Nothing here touches Meta.");
  say();

  say("## 1. Find the accounts");
  say();
  say("**You:** Launch our January Free Consultation offer across the first 4 locations of each business, A$80 a day each.");
  say();
  say("**Claude:** Let me see what accounts we have.");
  say();
  const accounts = await call("list_ad_accounts", {});
  say(`Result: ${accounts.data.count} ad accounts across ${accounts.data.businesses.length} businesses (${accounts.data.businesses.join(", ")}).`);
  const ids: string[] = [];
  for (const biz of accounts.data.businesses) ids.push(...accounts.data.accounts.filter((x: any) => x.business === biz).slice(0, 4).map((x: any) => x.id));
  say();

  say("## 2. Plan it (dry run, nothing created)");
  say();
  const spec: any = {
    name: "January Free Consultation",
    launch_key: "jan-free-consult-01",
    accounts: ids,
    objective: "OUTCOME_LEADS",
    daily_budget_cents: 8000,
    audiences: [{ name: "Local adults 25 to 65", countries: ["AU"], age_min: 25, age_max: 65 }],
    creatives: [
      { headline: "Book Your Free Consultation", body: "Same week appointments. No obligation.", link_url: "https://example.com/book" },
      { headline: "Your First Visit Is On Us", body: "Friendly local team, easy booking.", link_url: "https://example.com/book" },
    ],
  };
  const plan1 = await call("plan_bulk_launch", { spec });
  const table = (rows: any[]) => {
    say("| Account | Campaign | Daily budget | Already live | Cap | Status |");
    say("|---|---|---|---|---|---|");
    for (const r of rows) say(`| ${r.account} | \`${r.campaign_name}\` | ${money(r.daily_budget_cents)} | ${money(r.already_live_cents)} | ${money(r.cap_cents)} | ${r.status} |`);
  };
  say(`Plan \`${plan1.data.plan_id}\`: ${plan1.data.accounts} accounts, total ${plan1.data.total_daily_spend} a day, **${plan1.data.blocked_accounts} blocked**, ready to launch: ${plan1.data.ready_to_launch}.`);
  say();
  table(plan1.data.rows);
  const blocked = plan1.data.rows.find((r: any) => r.status === "blocked");
  say();
  say(`**Claude:** One account is blocked. ${blocked.why[0]}`);
  say();

  say("## 3. Fix the blocked account and plan again");
  say();
  const fixed = blocked.max_new_daily_budget_cents - 1000;
  say(`**Claude:** I will give ${blocked.account} ${money(fixed)} instead, which fits under its cap with room to spare.`);
  say();
  spec.budget_overrides = { [blocked.account_id]: fixed };
  const plan2 = await call("plan_bulk_launch", { spec });
  say(`Plan \`${plan2.data.plan_id}\`: total ${plan2.data.total_daily_spend} a day, ${plan2.data.blocked_accounts} blocked, ready to launch: ${plan2.data.ready_to_launch}.`);
  say();
  for (const n of plan2.data.notes) say(`- ${n}`);
  say();

  say("## 4. Launch it paused");
  say();
  const launched = await call("launch_plan", { plan_id: plan2.data.plan_id });
  say(`Result: ${launched.data.created} accounts created, ${launched.data.failed} failed, all paused: ${launched.data.all_paused}.`);
  say();
  say("**Claude:** The connection dropped on my side, so I will retry the launch to be sure.");
  say();
  const retry = await call("launch_plan", { plan_id: plan2.data.plan_id });
  say(`Result: ${retry.data.created} created, ${retry.data.replayed} replayed. A retry creates nothing twice.`);
  say();

  say("## 5. Publish needs a human");
  say();
  say("**Claude:** Everything is paused. Here is what going live would do.");
  say();
  const preview = await call("publish", { plan_id: plan2.data.plan_id });
  say(`Result: dry run. Would activate ${preview.data.would_activate.accounts} accounts, ${preview.data.would_activate.daily_spend} a day. Caps ok: ${preview.data.cap_check.ok}.`);
  say();
  say("**You:** Approved. Sam Rivera signs off.");
  say();
  const refused = await call("publish", { plan_id: plan2.data.plan_id, confirm: true, approver: "Claude" });
  say(`Result (refused): ${refused.data.reason}`);
  say();
  const live = await call("publish", { plan_id: plan2.data.plan_id, confirm: true, approver: "Sam Rivera" });
  say(`Result: published. Approved by ${live.data.approved_by}, ${live.data.campaigns_activated} campaigns active, ${live.data.daily_spend} a day.`);
  say();

  say("## 6. Six hours later: pacing");
  say();
  say("*(Simulated: six hours pass. Two accounts behave badly.)*");
  api.advanceHours(6);
  api.setPace(ids[0], 1.7, true);
  api.setPace(ids[4], 0.3, true);
  say();
  const pacing = await call("pacing_report", {});
  say(`Result: ${pacing.data.checked} accounts checked, **${pacing.data.flagged} flagged**.`);
  say();
  say("| Account | Expected so far | Spent so far | Pace | Status |");
  say("|---|---|---|---|---|");
  const flagged = pacing.data.accounts.filter((x: any) => x.status === "over" || x.status === "under");
  for (const r of flagged) say(`| ${r.account} | ${money(r.expected_so_far_cents)} | ${money(r.spent_so_far_cents)} | ${r.pace}x | ${r.status} |`);
  say();
  const over = flagged.find((x: any) => x.status === "over");
  say(`**Claude:** ${over.account} is spending ${over.pace}x its budget, and ${pacing.data.under_pacing[0]} is barely spending. I can pause either one with the kill switch, or leave them if you say so.`);
  say();
  const health = await call("account_health", { account_id: ids[0] });
  say(`Result: ${health.data.account}, spend today ${money(health.data.spend_today_cents)} against a ${money(health.data.daily_cap_cents)} cap. Flags: ${health.data.flags.join(" ")}`);
  say();
  const kill = await call("pause_campaigns", { scope: "account", account_id: ids[0] });
  say(`Result: ${kill.data.campaigns_paused} campaigns paused in ${kill.data.paused[0].account}, ${kill.data.daily_budget_removed} a day removed.`);
  say();
  return out.join("\n") + "\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.stdout.write(await runDemo());
