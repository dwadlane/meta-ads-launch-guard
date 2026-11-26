#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { MetaApi } from "./api.js";
import { DEFAULT_API_VERSION, HttpMetaClient } from "./client.js";
import { MockMetaApi } from "./mock.js";
import { buildServer } from "./server.js";

let api: MetaApi;
if (process.env.META_ACCESS_TOKEN && process.env.META_ALLOW_LIVE === "1") {
  const version = process.env.META_API_VERSION ?? DEFAULT_API_VERSION;
  api = new HttpMetaClient(process.env.META_ACCESS_TOKEN, { baseUrl: process.env.META_GRAPH_BASE_URL, version, defaultPageId: process.env.META_PAGE_ID });
  console.error(`meta-ads-launch-guard: LIVE mode against the Graph API ${version}. Every guard still applies.`);
} else {
  api = new MockMetaApi();
  console.error("meta-ads-launch-guard: running on the local mock (30 fictional ad accounts). Set META_ACCESS_TOKEN and META_ALLOW_LIVE=1 for the real API.");
}
await buildServer(api).connect(new StdioServerTransport());
