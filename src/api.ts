import type { Ad, AdAccount, AdSet, Campaign, Creative, InsightRow, Status, Targeting } from "./types.js";

export class MetaApiError extends Error {
  constructor(message: string, public code = 100, public status = 400) {
    super(message);
    this.name = "MetaApiError";
  }
}

/** The slice of the Marketing API this server uses. The mock and the HTTP client both implement it. */
export interface MetaApi {
  listAdAccounts(): Promise<AdAccount[]>; // GET /me/adaccounts
  listCampaigns(accountId: string): Promise<Campaign[]>; // GET /act_<id>/campaigns
  listAdSets(accountId: string): Promise<AdSet[]>; // GET /act_<id>/adsets
  listAds(accountId: string): Promise<Ad[]>; // GET /act_<id>/ads
  createCampaign(accountId: string, p: { name: string; objective: string; status: Status; special_ad_categories: string[]; buying_type?: string }): Promise<{ id: string }>; // POST /act_<id>/campaigns
  createAdSet(accountId: string, p: { name: string; campaign_id: string; daily_budget: string; billing_event: string; optimization_goal: string; bid_strategy: string; targeting: Targeting; status: Status }): Promise<{ id: string }>; // POST /act_<id>/adsets
  createAdCreative(accountId: string, p: { name: string; object_story_spec: Record<string, unknown>; degrees_of_freedom_spec?: Record<string, unknown> }): Promise<{ id: string }>; // POST /act_<id>/adcreatives
  createAd(accountId: string, p: { name: string; adset_id: string; creative: { creative_id: string }; status: Status }): Promise<{ id: string }>; // POST /act_<id>/ads
  update(id: string, p: { status?: Status; daily_budget?: string }): Promise<{ success: boolean }>; // POST /<id>
  getInsights(accountId: string, level: "account" | "campaign"): Promise<InsightRow[]>; // GET /act_<id>/insights?date_preset=today
  nowMs(): number;
}

export type { Creative };

/** Parse a Graph minor-unit string into an integer number of cents. */
export const cents = (v: string | number | undefined): number => Math.round(Number(v ?? 0));
