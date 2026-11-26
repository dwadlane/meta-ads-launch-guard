import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MetaApi } from "./api.js";
import { GuardError, loadGuard, type Guard } from "./guard.js";
import { launchPlan, publishPlan } from "./launch.js";
import { accountHealth, adjustBudget, listAdAccounts, pacingReport, pauseCampaigns } from "./ops.js";
import { LaunchSpecSchema, planBulkLaunch } from "./planner.js";
import { Store, type Ctx } from "./store.js";

const text = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: e instanceof GuardError ? JSON.stringify({ refused: true, reason: e.message, ...(e.details ? { details: e.details } : {}) }, null, 2) : e instanceof Error ? e.message : String(e) }],
});
const safe = <A,>(fn: (a: A) => Promise<unknown>) => async (a: A) => {
  try { return text(await fn(a)); } catch (e) { return fail(e); }
};

export function buildServer(api: MetaApi, opts: { guard?: Guard; store?: Store } = {}) {
  const ctx: Ctx = { api, guard: opts.guard ?? loadGuard(), store: opts.store ?? new Store() };
  const server = new McpServer({ name: "meta-ads-launch-guard", version: "0.1.0" });
  const read = { readOnlyHint: true, openWorldHint: true };
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

  server.registerTool("list_ad_accounts", {
    title: "List ad accounts",
    description: "Every ad account this token can see, with its business, currency and daily spend cap. Use the ids in plan_bulk_launch.",
    inputSchema: { business: z.string().optional().describe("Only accounts of this business") },
    annotations: read,
  }, safe(({ business }) => listAdAccounts(ctx, business)));

  server.registerTool("account_health", {
    title: "Account health",
    description: "One account: spend today against its cap, disapproved ads, pacing, and a plain list of anything that needs a look.",
    inputSchema: { account_id: z.string().describe("For example act_7100000001") },
    annotations: read,
  }, safe(({ account_id }) => accountHealth(ctx, account_id)));

  server.registerTool("plan_bulk_launch", {
    title: "Plan a bulk launch (dry run)",
    description: "Checks a launch spec against the guardrails and returns a dry-run plan: total daily spend and one row per account, with blocked rows explained. Creates nothing in Meta.",
    inputSchema: { spec: LaunchSpecSchema },
    annotations: read,
  }, safe(({ spec }) => planBulkLaunch(ctx, spec)));

  server.registerTool("launch_plan", {
    title: "Launch a plan (everything paused)",
    description: "Creates the campaigns, ad sets, creatives and ads for a ready plan. Everything is created PAUSED. Safe to retry: a retry never creates anything twice.",
    inputSchema: { plan_id: z.string() },
    annotations: write,
  }, safe(({ plan_id }) => launchPlan(ctx, plan_id)));

  server.registerTool("publish", {
    title: "Publish a launched plan (goes live)",
    description: "Flips a launched plan to ACTIVE. Without confirm=true it only previews. With confirm=true it needs the name of the human approver, and it refuses if any account or the global total would go over its cap.",
    inputSchema: {
      plan_id: z.string(),
      confirm: z.boolean().default(false).describe("Leave false to preview. Set true only after a person has approved the plan."),
      approver: z.string().optional().describe("Full name of the person who approved. Not a bot name."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, safe((a) => publishPlan(ctx, a)));

  server.registerTool("pause_campaigns", {
    title: "Kill switch",
    description: "Pauses every active campaign in one account, or in all accounts. Needs no confirmation, because pausing is the safe direction.",
    inputSchema: { scope: z.enum(["account", "all"]), account_id: z.string().optional().describe("Required when scope is account") },
    annotations: write,
  }, safe((a) => pauseCampaigns(ctx, a)));

  server.registerTool("pacing_report", {
    title: "Pacing report",
    description: "Spend so far today against what an even spread would have spent, per account, flagging over and under pacing.",
    inputSchema: { account_ids: z.array(z.string()).optional().describe("Default is every account") },
    annotations: read,
  }, safe(({ account_ids }) => pacingReport(ctx, account_ids)));

  server.registerTool("adjust_budget", {
    title: "Adjust a campaign budget",
    description: "Changes a campaign's daily budget. Refuses a move bigger than the per-edit limit in guard.json, and refuses a raise that would break a cap.",
    inputSchema: { account_id: z.string(), campaign_id: z.string(), daily_budget_cents: z.number().int().positive() },
    annotations: write,
  }, safe((a) => adjustBudget(ctx, a)));

  return server;
}
