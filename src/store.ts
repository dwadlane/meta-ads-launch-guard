import type { Guard } from "./guard.js";
import type { MetaApi } from "./api.js";
import type { Issue } from "./types.js";
import type { LaunchSpec } from "./planner.js";

export interface PlanRow {
  account_id: string;
  account_name: string;
  business: string;
  campaign_name: string;
  daily_budget_cents: number;
  committed_cents: number; // budget already live on the account
  projected_cents: number;
  cap_cents: number;
  max_new_daily_budget_cents: number;
  ad_sets: number;
  ads: number;
  status: "ok" | "blocked";
  issues: Issue[];
}

export interface AccountLaunch {
  account_id: string;
  state: "created" | "replayed" | "failed";
  campaign_id?: string;
  creative_ids: string[];
  adset_ids: string[];
  ad_ids: string[];
  adopted?: boolean;
  error?: string;
}

export interface PlanRecord {
  plan_id: string;
  launch_key: string;
  status: "planned" | "launched" | "partial" | "published";
  spec: LaunchSpec;
  rows: PlanRow[];
  total_daily_cents: number;
  issues: Issue[];
  notes: string[];
  ready_to_launch: boolean;
  created_at: string;
  launched?: AccountLaunch[];
  published?: { approved_by: string; at: string; campaigns: string[] };
}

export class Store {
  plans = new Map<string, PlanRecord>();
  /** Idempotency ledger: "<launch_key>|<account>" -> step key -> created Graph id. */
  private ledger = new Map<string, Record<string, string>>();
  audit: { at: string; event: string; detail: unknown }[] = [];
  progress(key: string) {
    if (!this.ledger.has(key)) this.ledger.set(key, {});
    return this.ledger.get(key)!;
  }
}

export interface Ctx { api: MetaApi; guard: Guard; store: Store }
