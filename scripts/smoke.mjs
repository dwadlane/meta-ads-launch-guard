// Smoke test: start the built server over stdio (mock mode) and drive it with the MCP SDK client.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";

const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { PATH: process.env.PATH }, stderr: "ignore" }));
const json = (r) => JSON.parse(r.content[0].text);
const call = async (name, args = {}) => json(await client.callTool({ name, arguments: args }));

const tools = (await client.listTools()).tools.map((t) => t.name);
assert.equal(tools.length, 8);
const accounts = await call("list_ad_accounts");
assert.equal(accounts.count, 30);
const spec = { name: "Smoke Test Offer", accounts: accounts.accounts.slice(0, 2).map((a) => a.id), daily_budget_cents: 3000, audiences: [{}], creatives: [{ headline: "Book Today", link_url: "https://example.com" }] };
const plan = await call("plan_bulk_launch", { spec });
assert.equal(plan.ready_to_launch, true);
const launched = await call("launch_plan", { plan_id: plan.plan_id });
assert.equal(launched.all_paused, true);
const preview = await call("publish", { plan_id: plan.plan_id });
assert.equal(preview.dry_run, true);
const refused = await client.callTool({ name: "publish", arguments: { plan_id: plan.plan_id, confirm: true } });
assert.equal(refused.isError, true);
const live = await call("publish", { plan_id: plan.plan_id, confirm: true, approver: "Sam Rivera" });
assert.equal(live.published, true);
const killed = await call("pause_campaigns", { scope: "all" });
assert.equal(killed.verified_live_budget_after_cents, 0);
await client.close();
console.log("smoke ok: 8 tools over stdio, plan, launch paused, publish refused without approver, publish with approver, kill switch");
