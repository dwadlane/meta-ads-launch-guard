import { MetaApiError, type MetaApi } from "./api.js";
import type { Ad, AdAccount, AdSet, Campaign, InsightRow } from "./types.js";

export const DEFAULT_API_VERSION = "v27.0";

type Fetch = typeof fetch;

/**
 * Real Graph API client. Same interface as the mock, so it can be dropped in with env vars.
 * Not exercised against the live API in tests or the demo. Live use needs a Meta app that has passed
 * app review with the ads_management permission (and ads_read for insights).
 */
export class HttpMetaClient implements MetaApi {
  private base: string;
  constructor(
    private token: string,
    opts: { baseUrl?: string; version?: string; defaultPageId?: string; fetchImpl?: Fetch; now?: () => number } = {},
  ) {
    this.base = `${(opts.baseUrl ?? "https://graph.facebook.com").replace(/\/$/, "")}/${opts.version ?? DEFAULT_API_VERSION}`;
    this.pageId = opts.defaultPageId ?? "";
    this.f = opts.fetchImpl ?? fetch;
    this.clock = opts.now ?? Date.now;
  }
  private pageId: string;
  private f: Fetch;
  private clock: () => number;
  nowMs() { return this.clock(); }

  private async call<T>(method: "GET" | "POST", path: string, params: Record<string, unknown> = {}): Promise<T> {
    let url = `${this.base}/${path}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` }; // token stays out of the URL
    const init: RequestInit = { method, headers };
    if (method === "GET") {
      const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
      url += `?${q}`;
    } else {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(params);
    }
    const res = await this.f(url, init);
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok || body.error) throw new MetaApiError(`(#${body.error?.code ?? res.status}) ${body.error?.message ?? res.statusText}`, body.error?.code ?? res.status, res.status);
    return body as T;
  }

  /** Follows Graph cursors with `after` so the token never has to ride in a `next` URL. */
  private async page<T>(path: string, params: Record<string, unknown>): Promise<T[]> {
    const out: T[] = [];
    let after: string | undefined;
    for (let i = 0; i < 40; i++) {
      const r = await this.call<{ data: T[]; paging?: { cursors?: { after?: string }; next?: string } }>("GET", path, { limit: 200, ...params, ...(after ? { after } : {}) });
      out.push(...r.data);
      after = r.paging?.next ? r.paging.cursors?.after : undefined;
      if (!after) break;
    }
    return out;
  }

  async listAdAccounts(): Promise<AdAccount[]> {
    const rows = await this.page<any>("me/adaccounts", { fields: "id,account_id,name,account_status,currency,timezone_name,business{name}" });
    return rows.map((r) => ({ id: r.id, account_id: r.account_id, name: r.name, business: r.business?.name ?? "Unassigned", currency: r.currency, account_status: r.account_status, timezone_name: r.timezone_name, page_id: this.pageId }));
  }
  listCampaigns(a: string) { return this.page<Campaign>(`${a}/campaigns`, { fields: "id,name,objective,status,effective_status,special_ad_categories,buying_type,updated_time" }).then((r) => r.map((c) => ({ ...c, account_id: a }))); }
  listAdSets(a: string) { return this.page<AdSet>(`${a}/adsets`, { fields: "id,name,campaign_id,status,effective_status,daily_budget,billing_event,optimization_goal,bid_strategy,targeting,updated_time" }).then((r) => r.map((s) => ({ ...s, account_id: a, daily_budget: s.daily_budget ?? "0" }))); }
  listAds(a: string) { return this.page<Ad>(`${a}/ads`, { fields: "id,name,adset_id,campaign_id,status,effective_status,creative{id},updated_time" }).then((r) => r.map((x) => ({ ...x, account_id: a }))); }
  createCampaign(a: string, p: Parameters<MetaApi["createCampaign"]>[1]) { return this.call<{ id: string }>("POST", `${a}/campaigns`, { buying_type: "AUCTION", ...p, is_adset_budget_sharing_enabled: false }); }
  createAdSet(a: string, p: Parameters<MetaApi["createAdSet"]>[1]) { return this.call<{ id: string }>("POST", `${a}/adsets`, p); }
  createAdCreative(a: string, p: Parameters<MetaApi["createAdCreative"]>[1]) { return this.call<{ id: string }>("POST", `${a}/adcreatives`, p); }
  createAd(a: string, p: Parameters<MetaApi["createAd"]>[1]) { return this.call<{ id: string }>("POST", `${a}/ads`, p); }
  update(id: string, p: { status?: string; daily_budget?: string }) { return this.call<{ success: boolean }>("POST", id, p); }
  async getInsights(a: string, level: "account" | "campaign"): Promise<InsightRow[]> {
    return this.page<InsightRow>(`${a}/insights`, { level, date_preset: "today", fields: "account_id,campaign_id,spend,impressions,clicks,date_start,date_stop" });
  }
}
