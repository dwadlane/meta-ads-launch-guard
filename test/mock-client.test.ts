import { describe, expect, it, vi } from "vitest";
import { MetaApiError } from "../src/api.js";
import { DEFAULT_API_VERSION, HttpMetaClient } from "../src/client.js";
import { MockMetaApi } from "../src/mock.js";
import { acct } from "./helpers.js";

describe("mock Marketing API", () => {
  it("ships 30 ad accounts across 3 businesses with Graph-style ids", async () => {
    const api = new MockMetaApi();
    const accounts = await api.listAdAccounts();
    expect(accounts).toHaveLength(30);
    expect(new Set(accounts.map((a) => a.business)).size).toBe(3);
    expect(accounts[0]).toMatchObject({ id: "act_7100000001", account_id: "7100000001", currency: "AUD" });
    const [c] = await api.listCampaigns(accounts[0].id);
    expect(c.id).toMatch(/^1202\d{14}$/);
  });
  it("keeps budgets as minor-unit strings and insights spend as a decimal string", async () => {
    const api = new MockMetaApi();
    const [s] = await api.listAdSets(acct(0, 1));
    expect(s.daily_budget).toBe("4000");
    const [row] = await api.getInsights(acct(0, 1), "account");
    expect(row.spend).toMatch(/^\d+\.\d{2}$/);
  });
  it("rejects bad input with a Graph-style error code", async () => {
    const api = new MockMetaApi();
    await expect(api.createAdSet(acct(0, 1), { name: "x", campaign_id: "nope", daily_budget: "5000", billing_event: "IMPRESSIONS", optimization_goal: "REACH", bid_strategy: "LOWEST_COST_WITHOUT_CAP", targeting: { geo_locations: { countries: ["AU"] } }, status: "PAUSED" })).rejects.toMatchObject({ code: 100 });
  });
  it("rejects location_spec on v27 ad sets", async () => {
    const api = new MockMetaApi();
    const { id } = await api.createCampaign(acct(0, 1), { name: "c", objective: "OUTCOME_LEADS", status: "PAUSED", special_ad_categories: [] });
    await expect(api.createAdSet(acct(0, 1), { name: "x", campaign_id: id, daily_budget: "5000", billing_event: "IMPRESSIONS", optimization_goal: "REACH", bid_strategy: "LOWEST_COST_WITHOUT_CAP", targeting: { geo_locations: { countries: ["AU"] }, location_spec: {} }, status: "PAUSED" })).rejects.toThrow(/v27/);
  });
  it("only spends while active, and keeps what it spent when paused", async () => {
    const api = new MockMetaApi();
    api.advanceHours(4);
    const [c] = await api.listCampaigns(acct(0, 1));
    const before = Number((await api.getInsights(acct(0, 1), "account"))[0].spend);
    await api.update(c.id, { status: "PAUSED" });
    api.advanceHours(6);
    expect(Number((await api.getInsights(acct(0, 1), "account"))[0].spend)).toBe(before);
  });
});

describe("HttpMetaClient", () => {
  const fake = (body: unknown, ok = true) => vi.fn(async () => ({ ok, status: ok ? 200 : 400, statusText: "Bad", json: async () => body }) as any);
  it("defaults to the current API version and keeps the token out of the URL", async () => {
    expect(DEFAULT_API_VERSION).toBe("v27.0");
    const f = fake({ data: [] });
    await new HttpMetaClient("TOKEN123", { fetchImpl: f }).listAdAccounts();
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toMatch(/^https:\/\/graph\.facebook\.com\/v27\.0\/me\/adaccounts\?/);
    expect(url).not.toContain("TOKEN123");
    expect(init.headers.Authorization).toBe("Bearer TOKEN123");
  });
  it("honours a custom base URL and version, and posts JSON", async () => {
    const f = fake({ id: "1" });
    await new HttpMetaClient("T", { baseUrl: "http://localhost:9999/", version: "v99.0", fetchImpl: f }).update("123", { status: "PAUSED" });
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("http://localhost:9999/v99.0/123");
    expect(JSON.parse(init.body)).toEqual({ status: "PAUSED" });
  });
  it("turns a Graph error into a MetaApiError", async () => {
    const f = fake({ error: { code: 190, message: "Invalid OAuth access token" } }, false);
    await expect(new HttpMetaClient("T", { fetchImpl: f }).listCampaigns("act_1")).rejects.toBeInstanceOf(MetaApiError);
  });
});
