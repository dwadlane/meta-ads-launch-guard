import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadGuard } from "../src/guard.js";
import { MockMetaApi } from "../src/mock.js";
import { buildServer } from "../src/server.js";
import { Store, type Ctx } from "../src/store.js";

export const ctxOf = (api = new MockMetaApi()): Ctx & { api: MockMetaApi } => ({ api, guard: loadGuard(), store: new Store() });

export const acct = (b: number, n: number) => `act_${7100000000 + b * 1000 + n}`;

export const spec = (over: Record<string, unknown> = {}) => ({
  name: "Summer Checkup",
  accounts: [acct(0, 1), acct(0, 3)],
  daily_budget_cents: 5000,
  audiences: [{ name: "Broad" }],
  creatives: [{ headline: "Book Your Free Checkup", body: "Same week appointments.", link_url: "https://example.com/book" }],
  ...over,
});

export async function connect(api = new MockMetaApi()) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer(api).connect(b);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(a);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { isError: !!r.isError, data: JSON.parse(r.content[0].text) };
  };
  return { client, api, call };
}
