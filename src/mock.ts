import { MetaApiError, type MetaApi } from "./api.js";
import type { Ad, AdAccount, AdSet, Campaign, Creative, EffectiveStatus, InsightRow, Status, Targeting } from "./types.js";

const DAY = 86_400_000;

export const MOCK_BUSINESSES = [
  { name: "Northside Dental", places: ["Chatswood", "Parramatta", "Bondi Junction", "Manly", "Penrith", "Liverpool", "Hornsby", "Newtown", "Cronulla", "Blacktown"], tz: "Australia/Sydney" },
  { name: "Coastal Moving Co", places: ["Gold Coast", "Brisbane", "Sunshine Coast", "Newcastle", "Wollongong", "Geelong", "Perth", "Adelaide", "Hobart", "Cairns"], tz: "Australia/Brisbane" },
  { name: "Peak Fitness Studios", places: ["Fitzroy", "Richmond", "St Kilda", "Brunswick", "Collingwood", "Prahran", "Carlton", "Footscray", "Hawthorn", "South Yarra"], tz: "Australia/Melbourne" },
];
const CODES: Record<string, string> = { "Northside Dental": "NSD", "Coastal Moving Co": "CMC", "Peak Fitness Studios": "PFS" };
/** Ads the mock marks as disapproved: [business index, place index, ad number]. */
const DISAPPROVED: [number, number][] = [[0, 4], [1, 1], [2, 6]];

interface Spend { accrued: number; since: number }

/**
 * In-process mock of the Marketing API object model: 30 fictional ad accounts across 3 businesses,
 * each with one live "always-on" campaign. Deterministic: fixed clock, counter ids, seeded pacing.
 * It validates inputs the way Graph does (error code 100 for bad params) and never touches the network.
 */
export class MockMetaApi implements MetaApi {
  private now: number;
  private n = 0;
  readonly accounts = new Map<string, AdAccount>();
  private campaigns = new Map<string, Campaign>();
  private adsets = new Map<string, AdSet>();
  private ads = new Map<string, Ad>();
  private creatives = new Map<string, Creative>();
  private spend = new Map<string, Spend>();
  private pace = new Map<string, number>();
  private review = new Set<string>();
  private failures = new Map<string, number>();
  calls: string[] = [];

  constructor(opts: { now?: Date } = {}) {
    this.now = (opts.now ?? new Date("2026-12-01T08:00:00Z")).getTime();
    const midnight = this.midnight();
    MOCK_BUSINESSES.forEach((b, bi) =>
      b.places.forEach((place, i) => {
        const num = i + 1;
        const accountId = String(7_100_000_000 + bi * 1000 + num);
        const id = `act_${accountId}`;
        this.accounts.set(id, { id, account_id: accountId, name: `${b.name} ${place}`, business: b.name, currency: "AUD", account_status: 1, timezone_name: b.tz, page_id: String(1_040_000_000 + bi * 1000 + num) });
        this.pace.set(id, 0.9 + (num % 5) * 0.05);
        const camp = this.seedCampaign(id, `${CODES[b.name]}_LEADS_always-on_202611`, midnight);
        const budget = 3000 + (num % 4) * 1000;
        const adset = this.seedAdSet(id, camp.id, `${camp.name}_AS_1`, budget, midnight);
        for (let a = 1; a <= 2; a++) {
          const ad = this.seedAd(id, adset, `${camp.name}_AD_${a}`);
          if (a === 1 && DISAPPROVED.some(([x, y]) => x === bi && y === i)) this.review.add(ad.id);
        }
      }),
    );
  }

  // ---- test and demo controls (not part of the Graph API) ----
  advanceHours(h: number) { this.now += h * 3_600_000; }
  /** Change how fast an account spends. With retroactive, spend already booked today is rescaled too (it has been running this way all day). */
  setPace(accountId: string, factor: number, retroactive = false) {
    this.settleAccount(accountId);
    if (retroactive) for (const s of this.adsets.values()) if (s.account_id === accountId) this.spend.get(s.id)!.accrued *= factor / (this.pace.get(accountId) ?? 1);
    this.pace.set(accountId, factor);
  }
  setAccountStatus(accountId: string, status: number) { this.accounts.get(accountId)!.account_status = status; }
  failCreateCampaign(accountId: string, times = 1) { this.failures.set(accountId, times); }

  // ---- reads ----
  nowMs() { return this.now; }
  private midnight() { const d = new Date(this.now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }
  private iso() { return new Date(this.now).toISOString(); }
  async listAdAccounts() { this.calls.push("GET /me/adaccounts"); return [...this.accounts.values()].map((a) => ({ ...a })); }
  async listCampaigns(accountId: string) { this.calls.push(`GET /${accountId}/campaigns`); return [...this.campaigns.values()].filter((c) => c.account_id === accountId).map((c) => this.viewCampaign(c)); }
  async listAdSets(accountId: string) { this.calls.push(`GET /${accountId}/adsets`); return [...this.adsets.values()].filter((s) => s.account_id === accountId).map((s) => this.viewAdSet(s)); }
  async listAds(accountId: string) { this.calls.push(`GET /${accountId}/ads`); return [...this.ads.values()].filter((a) => a.account_id === accountId).map((a) => this.viewAd(a)); }
  getCreative(id: string) { return this.creatives.get(id); }

  private viewCampaign(c: Campaign): Campaign { return { ...c, effective_status: c.status }; }
  private adsetEffective(s: AdSet): EffectiveStatus {
    if (this.campaigns.get(s.campaign_id)!.status === "PAUSED") return "CAMPAIGN_PAUSED";
    return s.status;
  }
  private viewAdSet(s: AdSet): AdSet { return { ...s, effective_status: this.adsetEffective(s) }; }
  private viewAd(a: Ad): Ad {
    const parent = this.adsetEffective(this.adsets.get(a.adset_id)!);
    let eff: EffectiveStatus = a.status;
    if (a.status === "ACTIVE") eff = parent === "CAMPAIGN_PAUSED" ? "CAMPAIGN_PAUSED" : parent === "PAUSED" ? "ADSET_PAUSED" : this.review.has(a.id) ? "DISAPPROVED" : "ACTIVE";
    return { ...a, effective_status: eff };
  }

  // ---- spend model: an active ad set spends daily_budget * elapsed/24h * the account's pace factor ----
  private isLive(s: AdSet) { return this.adsetEffective(s) === "ACTIVE"; }
  private settle(s: AdSet) {
    const sp = this.spend.get(s.id)!;
    if (this.isLive(s)) sp.accrued += (Number(s.daily_budget) * (this.now - sp.since) / DAY) * (this.pace.get(s.account_id) ?? 1);
    sp.since = this.now;
  }
  private settleAccount(accountId: string) { for (const s of this.adsets.values()) if (s.account_id === accountId) this.settle(s); }
  private spendCents(s: AdSet) {
    const sp = this.spend.get(s.id)!;
    const live = this.isLive(s) ? (Number(s.daily_budget) * (this.now - sp.since) / DAY) * (this.pace.get(s.account_id) ?? 1) : 0;
    return Math.round(sp.accrued + live);
  }

  async getInsights(accountId: string, level: "account" | "campaign"): Promise<InsightRow[]> {
    this.calls.push(`GET /${accountId}/insights?level=${level}&date_preset=today`);
    const day = new Date(this.midnight()).toISOString().slice(0, 10);
    const by = new Map<string, number>();
    for (const s of this.adsets.values()) if (s.account_id === accountId) by.set(s.campaign_id, (by.get(s.campaign_id) ?? 0) + this.spendCents(s));
    const row = (c: number, campaign_id?: string): InsightRow => ({
      account_id: accountId.replace("act_", ""), ...(campaign_id ? { campaign_id } : {}),
      spend: (c / 100).toFixed(2), impressions: String(Math.round((c / 100) * 80)), clicks: String(Math.round((c / 100) * 80 * 0.012)), date_start: day, date_stop: day,
    });
    if (level === "account") return [row([...by.values()].reduce((a, b) => a + b, 0))];
    return [...by].filter(([, c]) => c > 0).map(([id, c]) => row(c, id));
  }

  // ---- seeding ----
  private nextId() { return `1202${String(++this.n).padStart(14, "0")}`; }
  private seedCampaign(accountId: string, name: string, midnight: number): Campaign {
    const c: Campaign = { id: this.nextId(), account_id: accountId, name, objective: "OUTCOME_LEADS", status: "ACTIVE", effective_status: "ACTIVE", special_ad_categories: [], buying_type: "AUCTION", updated_time: new Date(midnight).toISOString() };
    this.campaigns.set(c.id, c);
    return c;
  }
  private seedAdSet(accountId: string, campaignId: string, name: string, budget: number, midnight: number): AdSet {
    const s: AdSet = { id: this.nextId(), account_id: accountId, campaign_id: campaignId, name, status: "ACTIVE", effective_status: "ACTIVE", daily_budget: String(budget), billing_event: "IMPRESSIONS", optimization_goal: "LEAD_GENERATION", bid_strategy: "LOWEST_COST_WITHOUT_CAP", targeting: { geo_locations: { countries: ["AU"] } }, updated_time: new Date(midnight).toISOString() };
    this.adsets.set(s.id, s);
    this.spend.set(s.id, { accrued: 0, since: midnight });
    return s;
  }
  private seedAd(accountId: string, s: AdSet, name: string): Ad {
    const a: Ad = { id: this.nextId(), account_id: accountId, adset_id: s.id, campaign_id: s.campaign_id, name, status: "ACTIVE", effective_status: "ACTIVE", creative: { id: "seed" }, updated_time: s.updated_time };
    this.ads.set(a.id, a);
    return a;
  }

  // ---- writes, validated like Graph ----
  private account(id: string) {
    if (!this.accounts.has(id)) throw new MetaApiError(`(#100) Unsupported get request. Object with ID '${id}' does not exist`, 100);
    return this.accounts.get(id)!;
  }
  async createCampaign(accountId: string, p: Parameters<MetaApi["createCampaign"]>[1]) {
    this.account(accountId);
    this.calls.push(`POST /${accountId}/campaigns`);
    const left = this.failures.get(accountId) ?? 0;
    if (left > 0) { this.failures.set(accountId, left - 1); throw new MetaApiError("(#17) User request limit reached", 17, 429); }
    if (!p.name) throw new MetaApiError("(#100) Param name must be specified", 100);
    if (!Array.isArray(p.special_ad_categories)) throw new MetaApiError("(#100) Param special_ad_categories must be specified", 100);
    if (!p.objective.startsWith("OUTCOME_")) throw new MetaApiError("(#100) Param objective must be one of the ODAX outcome objectives", 100);
    const c: Campaign = { id: this.nextId(), account_id: accountId, name: p.name, objective: p.objective, status: p.status, effective_status: p.status, special_ad_categories: p.special_ad_categories, buying_type: p.buying_type ?? "AUCTION", updated_time: this.iso() };
    this.campaigns.set(c.id, c);
    return { id: c.id };
  }
  async createAdSet(accountId: string, p: Parameters<MetaApi["createAdSet"]>[1]) {
    this.account(accountId);
    this.calls.push(`POST /${accountId}/adsets`);
    const camp = this.campaigns.get(p.campaign_id);
    if (!camp || camp.account_id !== accountId) throw new MetaApiError(`(#100) Invalid campaign_id ${p.campaign_id}`, 100);
    if (!/^\d+$/.test(p.daily_budget) || Number(p.daily_budget) < 100) throw new MetaApiError("(#100) Param daily_budget must be a whole number of minor units, at least 100", 100);
    if (!p.targeting?.geo_locations?.countries?.length) throw new MetaApiError("(#100) Param targeting[geo_locations] must be specified", 100);
    if ("location_spec" in p.targeting || "lookalike_spec" in p.targeting && (p.targeting as any).lookalike_spec?.country !== undefined)
      throw new MetaApiError("(#100) targeting location_spec and lookalike_spec.country are not accepted on v27.0", 100);
    const s: AdSet = { id: this.nextId(), account_id: accountId, campaign_id: p.campaign_id, name: p.name, status: p.status, effective_status: p.status, daily_budget: p.daily_budget, billing_event: p.billing_event, optimization_goal: p.optimization_goal, bid_strategy: p.bid_strategy, targeting: p.targeting, updated_time: this.iso() };
    this.adsets.set(s.id, s);
    this.spend.set(s.id, { accrued: 0, since: this.now });
    return { id: s.id };
  }
  async createAdCreative(accountId: string, p: Parameters<MetaApi["createAdCreative"]>[1]) {
    this.account(accountId);
    this.calls.push(`POST /${accountId}/adcreatives`);
    const link = (p.object_story_spec as any)?.link_data;
    if (!link?.link) throw new MetaApiError("(#100) Param object_story_spec[link_data][link] must be specified", 100);
    const c: Creative = { id: this.nextId(), account_id: accountId, name: p.name, object_story_spec: p.object_story_spec, degrees_of_freedom_spec: p.degrees_of_freedom_spec };
    this.creatives.set(c.id, c);
    return { id: c.id };
  }
  async createAd(accountId: string, p: Parameters<MetaApi["createAd"]>[1]) {
    this.account(accountId);
    this.calls.push(`POST /${accountId}/ads`);
    const s = this.adsets.get(p.adset_id);
    if (!s || s.account_id !== accountId) throw new MetaApiError(`(#100) Invalid adset_id ${p.adset_id}`, 100);
    if (!this.creatives.has(p.creative.creative_id)) throw new MetaApiError(`(#100) Invalid creative_id ${p.creative.creative_id}`, 100);
    const a: Ad = { id: this.nextId(), account_id: accountId, adset_id: s.id, campaign_id: s.campaign_id, name: p.name, status: p.status, effective_status: p.status, creative: { id: p.creative.creative_id }, updated_time: this.iso() };
    this.ads.set(a.id, a);
    return { id: a.id };
  }
  async update(id: string, p: { status?: Status; daily_budget?: string }) {
    this.calls.push(`POST /${id}`);
    const camp = this.campaigns.get(id), set = this.adsets.get(id), ad = this.ads.get(id);
    if (!camp && !set && !ad) throw new MetaApiError(`(#100) Unsupported post request. Object with ID '${id}' does not exist`, 100);
    if (p.daily_budget !== undefined && !set) throw new MetaApiError("(#100) daily_budget can only be set on an ad set in this mock", 100);
    const t = this.iso();
    if (camp) {
      for (const s of this.adsets.values()) if (s.campaign_id === id) this.settle(s);
      if (p.status) camp.status = p.status;
      camp.updated_time = t;
    } else if (set) {
      this.settle(set);
      if (p.status) set.status = p.status;
      if (p.daily_budget !== undefined) {
        if (!/^\d+$/.test(p.daily_budget) || Number(p.daily_budget) < 100) throw new MetaApiError("(#100) daily_budget must be a whole number of minor units, at least 100", 100);
        set.daily_budget = p.daily_budget;
      }
      set.updated_time = t;
    } else if (ad) {
      if (p.status) ad.status = p.status;
      ad.updated_time = t;
    }
    return { success: true };
  }
}
