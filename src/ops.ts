import { cents } from "./api.js";
import { GuardError, accountCap, checkBudgetChange, money } from "./guard.js";
import { liveCommitted } from "./planner.js";
import type { Ctx } from "./store.js";

const DAY = 86_400_000;
const dayStart = (ms: number) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };

export async function listAdAccounts(ctx: Ctx, business?: string) {
  const accounts = (await ctx.api.listAdAccounts()).filter((a) => !business || a.business === business);
  return { count: accounts.length, businesses: [...new Set(accounts.map((a) => a.business))], accounts: accounts.map((a) => ({ id: a.id, name: a.name, business: a.business, currency: a.currency, status: a.account_status === 1 ? "ACTIVE" : `status ${a.account_status}`, daily_cap_cents: accountCap(ctx.guard, a.id) })) };
}

interface Expected { expected: number; budget: number; campaign_id: string }

/** Expected spend so far today: budget times the share of the day an ad set has been live (since midnight or its last change). */
async function expectedByAccount(ctx: Ctx, accountId: string) {
  const now = ctx.api.nowMs();
  const sets = (await ctx.api.listAdSets(accountId)).filter((s) => s.effective_status === "ACTIVE");
  const rows: Expected[] = sets.map((s) => ({ campaign_id: s.campaign_id, budget: cents(s.daily_budget), expected: cents(s.daily_budget) * Math.max(0, now - Math.max(dayStart(now), Date.parse(s.updated_time))) / DAY }));
  return { rows, expected: rows.reduce((n, r) => n + r.expected, 0), budget: rows.reduce((n, r) => n + r.budget, 0) };
}

const status = (ctx: Ctx, expected: number, ratio: number) =>
  expected < ctx.guard.pacing.min_expected_cents ? "too_early" : ratio > ctx.guard.pacing.over_ratio ? "over" : ratio < ctx.guard.pacing.under_ratio ? "under" : "on_track";

export async function pacingReport(ctx: Ctx, accountIds?: string[]) {
  const ids = accountIds?.length ? accountIds : (await ctx.api.listAdAccounts()).map((a) => a.id);
  const names = new Map((await ctx.api.listAdAccounts()).map((a) => [a.id, a.name]));
  const out = await Promise.all(ids.map(async (id) => {
    const [exp, ins] = await Promise.all([expectedByAccount(ctx, id), ctx.api.getInsights(id, "account")]);
    const spent = Math.round(Number(ins[0]?.spend ?? 0) * 100);
    const ratio = exp.expected > 0 ? spent / exp.expected : 0;
    const st = status(ctx, exp.expected, ratio);
    const row: Record<string, unknown> = { account_id: id, account: names.get(id), live_daily_budget_cents: exp.budget, expected_so_far_cents: Math.round(exp.expected), spent_so_far_cents: spent, pace: Number(ratio.toFixed(2)), status: st };
    if (st === "over" || st === "under") {
      const camp = await ctx.api.getInsights(id, "campaign");
      const byCamp = new Map<string, number>();
      for (const r of exp.rows) byCamp.set(r.campaign_id, (byCamp.get(r.campaign_id) ?? 0) + r.expected);
      row.campaigns = camp.map((c) => ({ campaign_id: c.campaign_id, spent_so_far_cents: Math.round(Number(c.spend) * 100), expected_so_far_cents: Math.round(byCamp.get(c.campaign_id!) ?? 0) }));
    }
    return row;
  }));
  const flagged = out.filter((r) => r.status === "over" || r.status === "under");
  return {
    checked: out.length, flagged: flagged.length,
    over_pacing: flagged.filter((r) => r.status === "over").map((r) => r.account),
    under_pacing: flagged.filter((r) => r.status === "under").map((r) => r.account),
    thresholds: { over_above: ctx.guard.pacing.over_ratio, under_below: ctx.guard.pacing.under_ratio },
    accounts: [...flagged, ...out.filter((r) => !flagged.includes(r))],
    note: "Expected spend assumes an even spread across the hours an ad set has been live. It is a flag for a human to look at, not a verdict.",
  };
}

export async function accountHealth(ctx: Ctx, accountId: string) {
  const acct = (await ctx.api.listAdAccounts()).find((a) => a.id === accountId);
  if (!acct) throw new GuardError(`${accountId} is not an ad account this token can see.`);
  const [ins, ads, exp] = await Promise.all([ctx.api.getInsights(accountId, "account"), ctx.api.listAds(accountId), expectedByAccount(ctx, accountId)]);
  const spent = Math.round(Number(ins[0]?.spend ?? 0) * 100);
  const cap = accountCap(ctx.guard, accountId);
  const ratio = exp.expected > 0 ? spent / exp.expected : 0;
  const pace = status(ctx, exp.expected, ratio);
  const disapproved = ads.filter((a) => a.effective_status === "DISAPPROVED");
  const flags: string[] = [];
  if (acct.account_status !== 1) flags.push("Account is not active.");
  if (disapproved.length) flags.push(`${disapproved.length} disapproved ad${disapproved.length > 1 ? "s" : ""}.`);
  if (pace === "over" || pace === "under") flags.push(`Pacing is ${pace}.`);
  if (spent > cap) flags.push("Spend today is already over the daily cap.");
  return {
    account_id: accountId, account: acct.name, business: acct.business, status: acct.account_status === 1 ? "ACTIVE" : `status ${acct.account_status}`,
    spend_today_cents: spent, daily_cap_cents: cap, spend_vs_cap_pct: Number(((spent / cap) * 100).toFixed(1)),
    live_daily_budget_cents: exp.budget, headroom_cents: Math.max(0, cap - exp.budget),
    disapproved_ads: disapproved.map((a) => ({ id: a.id, name: a.name })),
    pacing: { status: pace, pace: Number(ratio.toFixed(2)) },
    flags, healthy: flags.length === 0,
  };
}

/** Kill switch. Pausing is the safe direction, so it never asks for confirmation. */
export async function pauseCampaigns(ctx: Ctx, a: { scope: "account" | "all"; account_id?: string }) {
  if (a.scope === "account" && !a.account_id) throw new GuardError("scope=account needs account_id.");
  const ids = a.scope === "all" ? (await ctx.api.listAdAccounts()).map((x) => x.id) : [a.account_id!];
  const names = new Map((await ctx.api.listAdAccounts()).map((x) => [x.id, x.name]));
  if (a.scope === "account" && !names.has(ids[0])) throw new GuardError(`${ids[0]} is not an ad account this token can see.`);
  const before = await liveCommitted(ctx, ids);
  const paused: { account_id: string; account: string | undefined; campaigns: string[]; daily_budget_removed_cents: number }[] = [];
  for (const id of ids) {
    const live = (await ctx.api.listCampaigns(id)).filter((c) => c.status === "ACTIVE");
    for (const c of live) await ctx.api.update(c.id, { status: "PAUSED" });
    if (live.length) paused.push({ account_id: id, account: names.get(id), campaigns: live.map((c) => c.id), daily_budget_removed_cents: before.get(id) ?? 0 });
  }
  const after = await liveCommitted(ctx, ids);
  const stillLive = [...after.values()].reduce((n, v) => n + v, 0);
  ctx.store.audit.push({ at: new Date(ctx.api.nowMs()).toISOString(), event: "pause_campaigns", detail: { scope: a.scope, account_id: a.account_id, campaigns: paused.reduce((n, p) => n + p.campaigns.length, 0) } });
  return { scope: a.scope, accounts_touched: paused.length, campaigns_paused: paused.reduce((n, p) => n + p.campaigns.length, 0), daily_budget_removed: money(paused.reduce((n, p) => n + p.daily_budget_removed_cents, 0)), verified_live_budget_after_cents: stillLive, paused };
}

export async function adjustBudget(ctx: Ctx, a: { account_id: string; campaign_id: string; daily_budget_cents: number }) {
  const { api, guard } = ctx;
  const camp = (await api.listCampaigns(a.account_id)).find((c) => c.id === a.campaign_id);
  if (!camp) throw new GuardError(`Campaign ${a.campaign_id} not found in ${a.account_id}.`);
  const sets = (await api.listAdSets(a.account_id)).filter((s) => s.campaign_id === a.campaign_id);
  const old = sets.reduce((n, s) => n + cents(s.daily_budget), 0);
  const bad = checkBudgetChange(guard, old, a.daily_budget_cents);
  if (bad) throw new GuardError(`${bad.message} Make it in steps.`);
  if (a.daily_budget_cents < guard.min_daily_budget_cents) throw new GuardError(`${money(a.daily_budget_cents)} is under the ${money(guard.min_daily_budget_cents)} minimum.`);
  if (camp.status === "ACTIVE" && a.daily_budget_cents > old) {
    const live = await liveCommitted(ctx);
    const acc = live.get(a.account_id) ?? 0, cap = accountCap(guard, a.account_id), grow = a.daily_budget_cents - old;
    if (acc + grow > cap) throw new GuardError(`This would put ${a.account_id} at ${money(acc + grow)} a day, over its ${money(cap)} cap.`);
    const total = [...live.values()].reduce((n, v) => n + v, 0);
    if (total + grow > guard.global_daily_cap_cents) throw new GuardError(`This would put all accounts at ${money(total + grow)} a day, over the global cap of ${money(guard.global_daily_cap_cents)}.`);
  }
  let left = a.daily_budget_cents;
  const updates = sets.map((s, i) => {
    const v = i === sets.length - 1 ? left : Math.round((cents(s.daily_budget) / old) * a.daily_budget_cents);
    left -= v;
    return { id: s.id, v };
  });
  for (const u of updates) await api.update(u.id, { daily_budget: String(u.v) });
  ctx.store.audit.push({ at: new Date(api.nowMs()).toISOString(), event: "adjust_budget", detail: { campaign_id: a.campaign_id, from: old, to: a.daily_budget_cents } });
  return { campaign_id: a.campaign_id, campaign_status: camp.status, old_daily_budget_cents: old, new_daily_budget_cents: a.daily_budget_cents, change_pct: Number((((a.daily_budget_cents - old) / old) * 100).toFixed(1)), ad_sets_updated: updates.length };
}
