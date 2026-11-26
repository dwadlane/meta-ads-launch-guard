import { createHash } from "node:crypto";
import { z } from "zod";
import { cents } from "./api.js";
import { OBJECTIVE_TOKEN, accountCap, campaignNameFor, checkAudienceFields, checkCreative, checkName, money, slugify } from "./guard.js";
import type { Ctx, PlanRecord, PlanRow } from "./store.js";
import type { Issue, Targeting } from "./types.js";

export const CreativeSchema = z.object({
  headline: z.string().describe("Ad headline, 40 characters or fewer"),
  body: z.string().optional().describe("Primary text, 125 characters or fewer"),
  link_url: z.string().optional().describe("Destination URL, https only"),
  call_to_action: z.string().default("LEARN_MORE"),
  image_hash: z.string().optional(),
});

export const AudienceSchema = z.object({
  name: z.string().default("Broad"),
  countries: z.array(z.string().length(2)).min(1).default(["AU"]),
  age_min: z.number().int().min(18).max(65).default(25),
  age_max: z.number().int().min(18).max(65).default(65),
  interests: z.array(z.string()).optional(),
  lookalike_spec: z.record(z.string(), z.unknown()).optional().describe("Rejected on v27.0 if it carries a country field"),
  location_spec: z.unknown().optional().describe("Rejected on v27.0. Use countries."),
});

export const LaunchSpecSchema = z.object({
  name: z.string().min(3).describe("Human campaign name, for example 'Summer Checkup'. It becomes the slug in the campaign name."),
  name_override: z.string().optional().describe("Use an exact campaign name. It must still match the naming convention."),
  launch_key: z.string().min(4).max(64).optional().describe("Idempotency key. Retrying with the same key never creates anything twice."),
  accounts: z.array(z.string()).optional().describe("Ad account ids, for example act_7100000001"),
  business: z.string().optional().describe("Add every account that belongs to this business"),
  objective: z.enum(Object.keys(OBJECTIVE_TOKEN) as [string, ...string[]]).default("OUTCOME_LEADS"),
  daily_budget_cents: z.number().int().positive().describe("Daily budget per account in cents, split evenly across its ad sets"),
  budget_overrides: z.record(z.string(), z.number().int().positive()).default({}).describe("Per-account daily budget in cents"),
  audiences: z.array(AudienceSchema).min(1).max(3).describe("One ad set per audience"),
  creatives: z.array(CreativeSchema).min(1).max(5).describe("Each creative becomes one ad in every ad set"),
});
export type LaunchSpec = z.output<typeof LaunchSpecSchema>;

const stable = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as any)[k])}`).join(",")}}` : JSON.stringify(v) ?? "null";

export const normId = (id: string) => (id.startsWith("act_") ? id : `act_${id}`);

export const OPTIMIZATION_GOAL: Record<string, string> = {
  OUTCOME_LEADS: "LEAD_GENERATION", OUTCOME_TRAFFIC: "LINK_CLICKS", OUTCOME_SALES: "OFFSITE_CONVERSIONS", OUTCOME_AWARENESS: "REACH", OUTCOME_ENGAGEMENT: "POST_ENGAGEMENT",
};

export function buildTargeting(ctx: Ctx, spec: LaunchSpec, a: LaunchSpec["audiences"][number]): Targeting {
  const t: Targeting = { geo_locations: { countries: a.countries }, age_min: a.age_min, age_max: a.age_max };
  if (a.interests?.length) t.interests = a.interests.map((name) => ({ name }));
  // v27: pin "Reach more people across other mobile devices" so Meta does not widen Sales targeting on its own.
  if (spec.objective === "OUTCOME_SALES") t.targeting_automation = { individual_setting: { device: ctx.guard.targeting.device_expansion } };
  return t;
}

export function buildCreativeDof(ctx: Ctx) {
  // v27: Product showcase can be auto-enabled on creatives. We set it explicitly.
  return { creative_features_spec: { product_extensions: { enroll_status: ctx.guard.creative.product_extensions_enroll_status } } };
}

/** Sum of daily budget that is actually delivering right now, per account. */
export async function liveCommitted(ctx: Ctx, accountIds?: string[]) {
  const ids = accountIds ?? (await ctx.api.listAdAccounts()).map((a) => a.id);
  const out = new Map<string, number>();
  await Promise.all(ids.map(async (id) => {
    const sets = await ctx.api.listAdSets(id);
    out.set(id, sets.filter((s) => s.effective_status === "ACTIVE").reduce((n, s) => n + cents(s.daily_budget), 0));
  }));
  return out;
}

export async function planBulkLaunch(ctx: Ctx, input: unknown) {
  const spec = LaunchSpecSchema.parse(input);
  const { guard } = ctx;
  const all = await ctx.api.listAdAccounts();
  const byId = new Map(all.map((a) => [a.id, a]));
  const issues: Issue[] = [];
  const seen = new Set<string>();
  const addIssue = (i: Issue) => { const k = `${i.code}|${i.account_id ?? ""}|${i.message}`; if (!seen.has(k)) { seen.add(k); issues.push(i); } };

  const ids: string[] = [];
  for (const raw of spec.accounts ?? []) {
    const id = normId(raw.trim());
    if (!byId.has(id)) addIssue({ code: "unknown_account", account_id: id, message: `${id} is not an ad account this token can see.` });
    else if (!ids.includes(id)) ids.push(id);
  }
  if (spec.business) {
    const hits = all.filter((a) => a.business === spec.business).map((a) => a.id);
    if (!hits.length) addIssue({ code: "unknown_business", message: `No ad accounts belong to "${spec.business}".` });
    for (const id of hits) if (!ids.includes(id)) ids.push(id);
  }
  if (!ids.length && !issues.length) addIssue({ code: "no_accounts", message: "The launch spec names no accounts. Pass accounts or business." });

  spec.creatives.forEach((c, i) => checkCreative(guard, c, `Creative ${i + 1}`).forEach(addIssue));
  spec.audiences.forEach((a, i) => {
    checkAudienceFields(a, `Audience ${i + 1} (${a.name})`).forEach(addIssue);
    if (a.age_min > a.age_max) addIssue({ code: "audience_age_range", message: `Audience ${i + 1} (${a.name}): age_min ${a.age_min} is above age_max ${a.age_max}.` });
  });

  const committed = await liveCommitted(ctx);
  const yyyymm = new Date(ctx.api.nowMs()).toISOString().slice(0, 7).replace("-", "");
  const slug = slugify(spec.name);
  const adSets = spec.audiences.length;
  const rows: PlanRow[] = ids.map((id) => {
    const acct = byId.get(id)!;
    const budget = spec.budget_overrides[id] ?? spec.daily_budget_cents;
    const name = spec.name_override ?? campaignNameFor(guard, acct.business, spec.objective, slug, yyyymm);
    const nameIssue = checkName(guard, name);
    if (nameIssue) addIssue(nameIssue);
    const live = committed.get(id) ?? 0;
    const cap = accountCap(guard, id);
    const rowIssues: Issue[] = [];
    if (acct.account_status !== 1) rowIssues.push({ code: "account_not_active", account_id: id, message: `${acct.name} is not an active ad account (status ${acct.account_status}).` });
    if (budget < guard.min_daily_budget_cents) rowIssues.push({ code: "budget_too_small", account_id: id, message: `${acct.name}: ${money(budget)} a day is under the ${money(guard.min_daily_budget_cents)} minimum.` });
    if (live + budget > cap)
      rowIssues.push({ code: "account_cap_exceeded", account_id: id, message: `${acct.name}: ${money(live)} already live plus ${money(budget)} new is ${money(live + budget)}, over the ${money(cap)} daily cap by ${money(live + budget - cap)}. The most this account can take is ${money(Math.max(0, cap - live))}.` });
    return {
      account_id: id, account_name: acct.name, business: acct.business, campaign_name: name, daily_budget_cents: budget,
      committed_cents: live, projected_cents: live + budget, cap_cents: cap, max_new_daily_budget_cents: Math.max(0, cap - live),
      ad_sets: adSets, ads: adSets * spec.creatives.length, status: rowIssues.length ? "blocked" : "ok", issues: rowIssues,
    };
  });

  const total = rows.reduce((n, r) => n + r.daily_budget_cents, 0);
  const liveTotal = [...committed.values()].reduce((n, v) => n + v, 0);
  if (liveTotal + total > guard.global_daily_cap_cents)
    addIssue({ code: "global_cap_exceeded", message: `${money(liveTotal)} already live across all accounts plus ${money(total)} in this plan is ${money(liveTotal + total)}, over the global daily cap of ${money(guard.global_daily_cap_cents)}.` });

  const notes: string[] = [];
  if (spec.objective === "OUTCOME_SALES")
    notes.push(`v27.0: Meta turns on "Reach more people across other mobile devices" by default for eligible Sales ad sets. We set targeting_automation.individual_setting.device to ${guard.targeting.device_expansion} on all ${rows.length * adSets} ad sets so targeting stays as planned.`);
  notes.push(`v27.0: Product showcase can be auto-enabled on creatives. We set product_extensions.enroll_status to ${guard.creative.product_extensions_enroll_status} on all ${rows.length * spec.creatives.length} creatives.`);
  notes.push("Everything launches PAUSED. Nothing spends until publish is called with confirm=true and an approver.");

  const plan_id = `plan_${createHash("sha256").update(stable(spec)).digest("hex").slice(0, 10)}`;
  const existing = ctx.store.plans.get(plan_id);
  if (existing && existing.status !== "planned") return summarize(existing, true);

  const rec: PlanRecord = {
    plan_id, launch_key: spec.launch_key ?? plan_id, status: "planned", spec, rows, total_daily_cents: total, issues, notes,
    ready_to_launch: issues.length === 0 && rows.every((r) => r.status === "ok") && rows.length > 0,
    created_at: new Date(ctx.api.nowMs()).toISOString(),
  };
  ctx.store.plans.set(plan_id, rec);
  return summarize(rec, false);
}

export function summarize(p: PlanRecord, existing: boolean) {
  const blocked = p.rows.filter((r) => r.status === "blocked");
  return {
    plan_id: p.plan_id, launch_key: p.launch_key, status: p.status, already_existed: existing || undefined,
    ready_to_launch: p.ready_to_launch,
    total_daily_spend: money(p.total_daily_cents), total_daily_cents: p.total_daily_cents,
    accounts: p.rows.length, blocked_accounts: blocked.length,
    rows: p.rows.map((r) => ({
      account_id: r.account_id, account: r.account_name, campaign_name: r.campaign_name, daily_budget_cents: r.daily_budget_cents,
      already_live_cents: r.committed_cents, cap_cents: r.cap_cents, ad_sets: r.ad_sets, ads: r.ads, status: r.status,
      ...(r.status === "blocked" ? { max_new_daily_budget_cents: r.max_new_daily_budget_cents, why: r.issues.map((i) => i.message) } : {}),
    })),
    issues: p.issues,
    notes: p.notes,
    next_step: p.ready_to_launch ? "Call launch_plan to create everything paused." : "Fix the blocked rows or issues (lower budget_overrides, fix creatives or names) and plan again.",
  };
}
