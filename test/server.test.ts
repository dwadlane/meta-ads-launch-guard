import { describe, expect, it } from "vitest";
import { acct, connect, spec } from "./helpers.js";

describe("MCP server", () => {
  it("registers the 8 tools", async () => {
    const { client } = await connect();
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["account_health", "adjust_budget", "list_ad_accounts", "launch_plan", "pacing_report", "pause_campaigns", "plan_bulk_launch", "publish"].sort());
  });
  it("runs plan, launch and publish end to end through the protocol", async () => {
    const { call } = await connect();
    const plan = await call("plan_bulk_launch", { spec: spec() });
    expect(plan.data.ready_to_launch).toBe(true);
    expect((await call("launch_plan", { plan_id: plan.data.plan_id })).data.all_paused).toBe(true);
    const refused = await call("publish", { plan_id: plan.data.plan_id, confirm: true });
    expect(refused.isError).toBe(true);
    expect(refused.data.refused).toBe(true);
    const ok = await call("publish", { plan_id: plan.data.plan_id, confirm: true, approver: "Sam Rivera" });
    expect(ok.data.published).toBe(true);
  });
  it("returns guard refusals as tool errors with a plain reason", async () => {
    const { call } = await connect();
    const r = await call("launch_plan", { plan_id: "plan_nope" });
    expect(r).toMatchObject({ isError: true, data: { refused: true } });
  });
  it("lists accounts by business", async () => {
    const { call } = await connect();
    const r = await call("list_ad_accounts", { business: "Peak Fitness Studios" });
    expect(r.data.count).toBe(10);
    expect(r.data.accounts.find((a: any) => a.id === acct(2, 9)).daily_cap_cents).toBe(10000);
  });
});
