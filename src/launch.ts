import { cents } from "./api.js";
import { GuardError, accountCap, checkApprover, checkName, money } from "./guard.js";
import { OPTIMIZATION_GOAL, buildCreativeDof, buildTargeting, liveCommitted } from "./planner.js";
import type { AccountLaunch, Ctx, PlanRecord, PlanRow } from "./store.js";

/** Create one account's campaign, ad sets, creatives and ads, all PAUSED. Safe to run again after a failure. */
async function launchAccount(ctx: Ctx, plan: PlanRecord, row: PlanRow, pageId: string): Promise<AccountLaunch> {
  const { api } = ctx;
  const spec = plan.spec;
  const prog = ctx.store.progress(`${plan.launch_key}|${row.account_id}`);
  const out: AccountLaunch = { account_id: row.account_id, state: "replayed", creative_ids: [], adset_ids: [], ad_ids: [] };
  let existing: Promise<{ c: Map<string, any>; s: Map<string, any>; a: Map<string, any> }> | undefined;
  const lookup = () => (existing ??= Promise.all([api.listCampaigns(row.account_id), api.listAdSets(row.account_id), api.listAds(row.account_id)]).then(([c, s, a]) => ({
    c: new Map(c.map((x) => [x.name, x])), s: new Map(s.map((x) => [x.name, x])), a: new Map(a.map((x) => [x.name, x])),
  })));

  // A step runs once per launch key. A lost ledger is covered by looking the object up by name before creating it.
  const step = async (key: string, kind: "c" | "s" | "a" | null, name: string, create: () => Promise<{ id: string }>) => {
    if (prog[key]) return prog[key];
    if (kind) {
      const found = (await lookup())[kind].get(name);
      if (found) {
        if (found.status === "ACTIVE") throw new Error(`"${name}" already exists and is ACTIVE. Refusing to adopt a live object.`);
        out.adopted = true;
        return (prog[key] = found.id);
      }
    }
    const { id } = await create();
    out.state = "created";
    return (prog[key] = id);
  };

  try {
    const creativeIds: string[] = [];
    for (const [k, c] of spec.creatives.entries()) {
      const link = { link: c.link_url, message: c.body, name: c.headline, call_to_action: { type: c.call_to_action, value: { link: c.link_url } }, ...(c.image_hash ? { image_hash: c.image_hash } : {}) };
      creativeIds.push(await step(`creative:${k}`, null, "", () => api.createAdCreative(row.account_id, { name: `${row.campaign_name}_CR_${k + 1}`, object_story_spec: { page_id: pageId, link_data: link }, degrees_of_freedom_spec: buildCreativeDof(ctx) })));
    }
    out.creative_ids = creativeIds;
    out.campaign_id = await step("campaign", "c", row.campaign_name, () => api.createCampaign(row.account_id, { name: row.campaign_name, objective: spec.objective, status: "PAUSED", special_ad_categories: [] }));
    const n = spec.audiences.length;
    const base = Math.floor(row.daily_budget_cents / n);
    for (const [j, aud] of spec.audiences.entries()) {
      const budget = base + (j === 0 ? row.daily_budget_cents - base * n : 0);
      const asName = `${row.campaign_name}_AS_${j + 1}`;
      const asId = await step(`adset:${j}`, "s", asName, () => api.createAdSet(row.account_id, {
        name: asName, campaign_id: out.campaign_id!, daily_budget: String(budget), billing_event: "IMPRESSIONS", optimization_goal: OPTIMIZATION_GOAL[spec.objective],
        bid_strategy: "LOWEST_COST_WITHOUT_CAP", targeting: buildTargeting(ctx, spec, aud), status: "PAUSED",
      }));
      out.adset_ids.push(asId);
      for (const k of spec.creatives.keys()) {
        const adName = `${asName}_AD_${k + 1}`;
        out.ad_ids.push(await step(`ad:${j}:${k}`, "a", adName, () => api.createAd(row.account_id, { name: adName, adset_id: asId, creative: { creative_id: creativeIds[k] }, status: "PAUSED" })));
      }
    }
  } catch (e) {
    out.state = "failed";
    out.error = e instanceof Error ? e.message : String(e);
  }
  return out;
}

export async function launchPlan(ctx: Ctx, planId: string) {
  const plan = ctx.store.plans.get(planId);
  if (!plan) throw new GuardError(`No plan ${planId}. Run plan_bulk_launch first.`);
  if (!plan.ready_to_launch) throw new GuardError(`Plan ${planId} is not ready to launch. Fix these first, then plan again.`, { blocked: plan.rows.filter((r) => r.status === "blocked").map((r) => r.issues.map((i) => i.message)).flat(), issues: plan.issues });
  const accounts = new Map((await ctx.api.listAdAccounts()).map((a) => [a.id, a]));
  // Naming is re-checked here, because a plan can sit for a while.
  for (const r of plan.rows) { const bad = checkName(ctx.guard, r.campaign_name); if (bad) throw new GuardError(bad.message); }

  const results: AccountLaunch[] = [];
  for (const row of plan.rows) results.push(await launchAccount(ctx, plan, row, accounts.get(row.account_id)!.page_id));
  const failed = results.filter((r) => r.state === "failed");
  if (plan.status !== "published") plan.status = failed.length ? "partial" : "launched";
  plan.launched = results;
  ctx.store.audit.push({ at: new Date(ctx.api.nowMs()).toISOString(), event: "launch_plan", detail: { plan_id: planId, created: results.filter((r) => r.state === "created").length, replayed: results.filter((r) => r.state === "replayed").length, failed: failed.length } });
  return {
    plan_id: planId, status: plan.status,
    created: results.filter((r) => r.state === "created").length,
    replayed: results.filter((r) => r.state === "replayed").length,
    failed: failed.length,
    all_paused: true,
    accounts: results.map((r) => ({ account_id: r.account_id, state: r.state, campaign_id: r.campaign_id, ad_set_ids: r.adset_ids, ad_ids: r.ad_ids, ...(r.error ? { error: r.error } : {}) })),
    next_step: failed.length ? "Some accounts failed. Call launch_plan again: finished accounts are skipped, so nothing is created twice." : "Everything is created and PAUSED. Show the plan to the approver, then call publish with confirm=true and their name.",
  };
}

export async function publishPlan(ctx: Ctx, a: { plan_id: string; confirm?: boolean; approver?: string }) {
  const { api, guard } = ctx;
  const plan = ctx.store.plans.get(a.plan_id);
  if (!plan) throw new GuardError(`No plan ${a.plan_id}.`);
  if (plan.status === "published") return { published: true, already_published: true, approved_by: plan.published!.approved_by, at: plan.published!.at };
  if (plan.status !== "launched" || !plan.launched) throw new GuardError(`Plan ${a.plan_id} is "${plan.status}". Every account must be launched (paused) before publish.`);

  // Live re-check, because other launches or edits may have happened since the plan was made.
  const live = await liveCommitted(ctx);
  const planned = new Map<string, number>();
  const planAdSets = new Map<string, string[]>();
  for (const l of plan.launched) {
    const sets = (await api.listAdSets(l.account_id)).filter((s) => l.adset_ids.includes(s.id));
    planned.set(l.account_id, sets.filter((s) => s.effective_status !== "ACTIVE").reduce((n, s) => n + cents(s.daily_budget), 0));
    planAdSets.set(l.account_id, l.adset_ids);
  }
  const violations: string[] = [];
  for (const [id, add] of planned) {
    const cap = accountCap(guard, id), now = live.get(id) ?? 0;
    if (now + add > cap) violations.push(`${id}: ${money(now)} live plus ${money(add)} would be ${money(now + add)}, over the ${money(cap)} cap.`);
  }
  const planTotal = [...planned.values()].reduce((n, v) => n + v, 0);
  const liveTotal = [...live.values()].reduce((n, v) => n + v, 0);
  if (liveTotal + planTotal > guard.global_daily_cap_cents) violations.push(`Global: ${money(liveTotal)} live plus ${money(planTotal)} would be ${money(liveTotal + planTotal)}, over the global cap of ${money(guard.global_daily_cap_cents)}.`);

  if (a.confirm !== true)
    return { published: false, dry_run: true, would_activate: { accounts: planned.size, daily_spend: money(planTotal) }, cap_check: { ok: violations.length === 0, violations }, next_step: "Nothing is live. To publish, call again with confirm=true and approver set to the name of the person who approved." };
  const approver = checkApprover(guard, a.approver);
  if (violations.length) throw new GuardError("publish refused: it would break a spend cap. Nothing was activated.", { violations });

  const flipped: string[] = [];
  try {
    for (const l of plan.launched) {
      for (const id of l.ad_ids) await api.update(id, { status: "ACTIVE" });
      for (const id of planAdSets.get(l.account_id)!) await api.update(id, { status: "ACTIVE" });
      await api.update(l.campaign_id!, { status: "ACTIVE" }); // last, because the campaign gates delivery
      flipped.push(l.campaign_id!);
    }
  } catch (e) {
    for (const id of flipped) await api.update(id, { status: "PAUSED" }).catch(() => undefined);
    throw new GuardError(`publish failed part way and was rolled back (${flipped.length} campaigns re-paused): ${e instanceof Error ? e.message : e}`);
  }
  const at = new Date(api.nowMs()).toISOString();
  plan.status = "published";
  plan.published = { approved_by: approver, at, campaigns: flipped };
  ctx.store.audit.push({ at, event: "publish", detail: { plan_id: plan.plan_id, approved_by: approver, campaigns: flipped.length, daily_cents: planTotal } });
  return { published: true, approved_by: approver, at, campaigns_activated: flipped.length, daily_spend: money(planTotal), next_step: "Live. Run pacing_report in a few hours to check spend against budget." };
}
