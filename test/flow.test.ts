import { describe, expect, it } from "vitest";
import { GuardError } from "../src/guard.js";
import { launchPlan, publishPlan } from "../src/launch.js";
import { adjustBudget, accountHealth, pacingReport, pauseCampaigns } from "../src/ops.js";
import { planBulkLaunch } from "../src/planner.js";
import { acct, ctxOf, spec } from "./helpers.js";

const ready = async (ctx = ctxOf(), over: Record<string, unknown> = {}) => {
  const plan: any = await planBulkLaunch(ctx, spec(over));
  expect(plan.ready_to_launch).toBe(true);
  return { ctx, plan };
};

describe("plan_bulk_launch", () => {
  it("returns a dry run with per-account rows and a total, and creates nothing", async () => {
    const ctx = ctxOf();
    const before = (await ctx.api.listCampaigns(acct(0, 1))).length;
    const plan: any = await planBulkLaunch(ctx, spec());
    expect(plan).toMatchObject({ ready_to_launch: true, total_daily_cents: 10000, accounts: 2, blocked_accounts: 0 });
    expect(plan.rows[0]).toMatchObject({ campaign_name: expect.stringMatching(/^NSD_LEADS_summer-checkup_202612$/), ad_sets: 1, ads: 1 });
    expect((await ctx.api.listCampaigns(acct(0, 1))).length).toBe(before);
    expect(ctx.api.calls.some((c) => c.startsWith("POST"))).toBe(false);
  });
  it("blocks an account that would exceed its cap and says how much it can take", async () => {
    const plan: any = await planBulkLaunch(ctxOf(), spec({ accounts: [acct(0, 2)], daily_budget_cents: 8000 }));
    expect(plan.ready_to_launch).toBe(false);
    expect(plan.rows[0]).toMatchObject({ status: "blocked", max_new_daily_budget_cents: 7000 });
    expect(plan.rows[0].why[0]).toMatch(/over the A\$120\.00 daily cap/);
  });
  it("a budget override fixes the blocked account", async () => {
    const plan: any = await planBulkLaunch(ctxOf(), spec({ accounts: [acct(0, 2)], daily_budget_cents: 8000, budget_overrides: { [acct(0, 2)]: 6000 } }));
    expect(plan.ready_to_launch).toBe(true);
  });
  it("blocks the plan when the global cap would be exceeded", async () => {
    const plan: any = await planBulkLaunch(ctxOf(), spec({ business: undefined, accounts: undefined, daily_budget_cents: 6000, ...{ accounts: Array.from({ length: 30 }, (_, i) => acct(Math.floor(i / 10), (i % 10) + 1)) } }));
    expect(plan.issues.map((i: any) => i.code)).toContain("global_cap_exceeded");
    expect(plan.blocked_accounts).toBe(0);
    expect(plan.ready_to_launch).toBe(false);
  });
  it("flags naming, creative and unknown-account problems together", async () => {
    const plan: any = await planBulkLaunch(ctxOf(), spec({ name_override: "bad name", accounts: [acct(0, 1), "act_999"], creatives: [{ headline: "x".repeat(60) }] }));
    const codes = plan.issues.map((i: any) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["naming_convention", "unknown_account", "creative_headline_too_long", "creative_url_missing"]));
  });
  it("rejects v27-removed audience fields", async () => {
    const plan: any = await planBulkLaunch(ctxOf(), spec({ audiences: [{ name: "LAL", lookalike_spec: { country: "AU" }, location_spec: {} }] }));
    expect(plan.issues.map((i: any) => i.code)).toEqual(expect.arrayContaining(["rejected_field_location_spec", "rejected_field_lookalike_country"]));
  });
  it("gives the same plan id for the same spec", async () => {
    const a: any = await planBulkLaunch(ctxOf(), spec());
    const b: any = await planBulkLaunch(ctxOf(), spec());
    expect(a.plan_id).toBe(b.plan_id);
  });
  it("flags the v27 device-expansion and product-showcase defaults in the plan", async () => {
    const plan: any = await planBulkLaunch(ctxOf(), spec({ objective: "OUTCOME_SALES" }));
    expect(plan.notes.join(" ")).toMatch(/other mobile devices/);
    expect(plan.notes.join(" ")).toMatch(/Product showcase.*OPT_OUT/);
  });
});

describe("launch_plan", () => {
  it("creates everything PAUSED, with v27 settings set explicitly", async () => {
    const { ctx, plan } = await ready(ctxOf(), { objective: "OUTCOME_SALES", audiences: [{ name: "A" }, { name: "B" }], creatives: [{ headline: "One", link_url: "https://x.com" }, { headline: "Two", link_url: "https://x.com" }] });
    const r: any = await launchPlan(ctx, plan.plan_id);
    expect(r).toMatchObject({ created: 2, failed: 0, all_paused: true });
    const camp = (await ctx.api.listCampaigns(acct(0, 1))).find((c) => c.id === r.accounts[0].campaign_id)!;
    expect(camp.status).toBe("PAUSED");
    const sets = (await ctx.api.listAdSets(acct(0, 1))).filter((s) => r.accounts[0].ad_set_ids.includes(s.id));
    expect(sets).toHaveLength(2);
    expect(sets.every((s) => s.status === "PAUSED" && s.targeting.targeting_automation?.individual_setting?.device === 0)).toBe(true);
    expect(sets.reduce((n, s) => n + Number(s.daily_budget), 0)).toBe(5000);
    const ads = (await ctx.api.listAds(acct(0, 1))).filter((a) => r.accounts[0].ad_ids.includes(a.id));
    expect(ads).toHaveLength(4);
    expect(ads.every((a) => a.status === "PAUSED")).toBe(true);
    const cr = ctx.api.getCreative(r.accounts[0].ad_ids.length ? ads[0].creative.id : "")!;
    expect((cr.degrees_of_freedom_spec as any).creative_features_spec.product_extensions.enroll_status).toBe("OPT_OUT");
  });
  it("refuses a plan that is not ready", async () => {
    const ctx = ctxOf();
    const plan: any = await planBulkLaunch(ctx, spec({ accounts: [acct(0, 2)], daily_budget_cents: 8000 }));
    await expect(launchPlan(ctx, plan.plan_id)).rejects.toBeInstanceOf(GuardError);
  });
  it("a retry never double-creates", async () => {
    const { ctx, plan } = await ready();
    await launchPlan(ctx, plan.plan_id);
    const count = async () => (await ctx.api.listCampaigns(acct(0, 1))).length;
    const n = await count();
    const again: any = await launchPlan(ctx, plan.plan_id);
    expect(again).toMatchObject({ created: 0, replayed: 2 });
    expect(await count()).toBe(n);
  });
  it("after a partial failure, a retry finishes the rest and creates nothing twice", async () => {
    const { ctx, plan } = await ready();
    ctx.api.failCreateCampaign(acct(0, 3));
    const first: any = await launchPlan(ctx, plan.plan_id);
    expect(first).toMatchObject({ created: 1, failed: 1 });
    expect((await ctx.api.listCampaigns(acct(0, 1))).filter((c) => c.name.includes("summer")).length).toBe(1);
    const second: any = await launchPlan(ctx, plan.plan_id);
    expect(second).toMatchObject({ created: 1, replayed: 1, failed: 0 });
    expect((await ctx.api.listCampaigns(acct(0, 1))).filter((c) => c.name.includes("summer")).length).toBe(1);
    expect((await ctx.api.listCampaigns(acct(0, 3))).filter((c) => c.name.includes("summer")).length).toBe(1);
  });
  it("adopts by name when the ledger is lost, so a restart does not duplicate either", async () => {
    const { ctx, plan } = await ready();
    await launchPlan(ctx, plan.plan_id);
    const fresh = { ...ctx, store: new (ctx.store.constructor as any)() };
    const p2: any = await planBulkLaunch(fresh, spec());
    const r: any = await launchPlan(fresh, p2.plan_id);
    expect(r.failed).toBe(0);
    expect((await ctx.api.listCampaigns(acct(0, 1))).filter((c) => c.name.includes("summer")).length).toBe(1);
  });
});

describe("publish", () => {
  const launched = async (over: Record<string, unknown> = {}) => {
    const { ctx, plan } = await ready(ctxOf(), over);
    await launchPlan(ctx, plan.plan_id);
    return { ctx, id: plan.plan_id as string };
  };
  it("previews without confirm and changes nothing", async () => {
    const { ctx, id } = await launched();
    const r: any = await publishPlan(ctx, { plan_id: id });
    expect(r).toMatchObject({ published: false, dry_run: true, cap_check: { ok: true } });
    expect((await ctx.api.listCampaigns(acct(0, 1))).filter((c) => c.status === "ACTIVE" && c.name.includes("summer"))).toHaveLength(0);
  });
  it("refuses confirm=true without an approver, or with a bot name", async () => {
    const { ctx, id } = await launched();
    await expect(publishPlan(ctx, { plan_id: id, confirm: true })).rejects.toThrow(/approver/);
    await expect(publishPlan(ctx, { plan_id: id, confirm: true, approver: "Claude" })).rejects.toThrow(/not a person/);
  });
  it("goes live with confirm and an approver, and records who approved", async () => {
    const { ctx, id } = await launched();
    const r: any = await publishPlan(ctx, { plan_id: id, confirm: true, approver: "Sam Rivera" });
    expect(r).toMatchObject({ published: true, approved_by: "Sam Rivera", campaigns_activated: 2 });
    const live = (await ctx.api.listAdSets(acct(0, 1))).filter((s) => s.effective_status === "ACTIVE");
    expect(live).toHaveLength(2);
    expect(ctx.store.audit.at(-1)).toMatchObject({ event: "publish", detail: { approved_by: "Sam Rivera" } });
    expect(await publishPlan(ctx, { plan_id: id, confirm: true, approver: "Sam Rivera" })).toMatchObject({ already_published: true });
  });
  it("refuses at publish time when live state has moved and an account would go over its cap", async () => {
    const ctx = ctxOf();
    const a: any = await planBulkLaunch(ctx, spec({ name: "Offer A", accounts: [acct(0, 1)], daily_budget_cents: 12000 }));
    const b: any = await planBulkLaunch(ctx, spec({ name: "Offer B", accounts: [acct(0, 1)], daily_budget_cents: 12000 }));
    expect([a.ready_to_launch, b.ready_to_launch]).toEqual([true, true]);
    await launchPlan(ctx, a.plan_id);
    await launchPlan(ctx, b.plan_id);
    await publishPlan(ctx, { plan_id: a.plan_id, confirm: true, approver: "Sam Rivera" });
    await expect(publishPlan(ctx, { plan_id: b.plan_id, confirm: true, approver: "Sam Rivera" })).rejects.toMatchObject({ details: { violations: [expect.stringMatching(/over the A\$200\.00 cap/)] } });
    expect((await ctx.api.listAdSets(acct(0, 1))).filter((s) => s.effective_status === "ACTIVE" && s.name.includes("offer-b"))).toHaveLength(0);
  });
});

describe("pause_campaigns, adjust_budget, pacing, health", () => {
  it("kill switch pauses one account, then all", async () => {
    const ctx = ctxOf();
    const one: any = await pauseCampaigns(ctx, { scope: "account", account_id: acct(0, 1) });
    expect(one).toMatchObject({ campaigns_paused: 1, verified_live_budget_after_cents: 0 });
    const all: any = await pauseCampaigns(ctx, { scope: "all" });
    expect(all.campaigns_paused).toBe(29);
    expect(all.verified_live_budget_after_cents).toBe(0);
    await expect(pauseCampaigns(ctx, { scope: "account" })).rejects.toThrow(/account_id/);
  });
  it("adjust_budget enforces the per-edit limit and the cap", async () => {
    const ctx = ctxOf();
    const [c] = await ctx.api.listCampaigns(acct(0, 1));
    await expect(adjustBudget(ctx, { account_id: acct(0, 1), campaign_id: c.id, daily_budget_cents: 6000 })).rejects.toThrow(/50% move/);
    expect(await adjustBudget(ctx, { account_id: acct(0, 1), campaign_id: c.id, daily_budget_cents: 5000 })).toMatchObject({ old_daily_budget_cents: 4000, new_daily_budget_cents: 5000, change_pct: 25 });
    const [c2] = await ctx.api.listCampaigns(acct(0, 2));
    await ctx.api.update((await ctx.api.listAdSets(acct(0, 2)))[0].id, { daily_budget: "9500" });
    await expect(adjustBudget(ctx, { account_id: acct(0, 2), campaign_id: c2.id, daily_budget_cents: 12100 })).rejects.toThrow(/over its A\$120\.00 cap/);
  });
  it("pacing report flags over and under, and leaves the rest alone", async () => {
    const ctx = ctxOf();
    ctx.api.advanceHours(6);
    ctx.api.setPace(acct(0, 1), 1.7, true);
    ctx.api.setPace(acct(1, 1), 0.3, true);
    const r: any = await pacingReport(ctx);
    expect(r).toMatchObject({ flagged: 2, over_pacing: [expect.stringContaining("Chatswood")], under_pacing: [expect.stringContaining("Gold Coast")] });
  });
  it("account health lists disapproved ads and spend against the cap", async () => {
    const h: any = await accountHealth(ctxOf(), acct(0, 5));
    expect(h.disapproved_ads).toHaveLength(1);
    expect(h).toMatchObject({ healthy: false, daily_cap_cents: 20000 });
    expect(h.flags[0]).toMatch(/disapproved/);
  });
});
