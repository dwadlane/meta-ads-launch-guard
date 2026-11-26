// Object model modelled on the Meta Marketing API (Graph API). Budgets are strings of minor units
// (cents), exactly like Graph returns them. Insights spend is a decimal string in major units.
export type Status = "ACTIVE" | "PAUSED";
export type EffectiveStatus = Status | "DISAPPROVED" | "CAMPAIGN_PAUSED" | "ADSET_PAUSED";

export interface AdAccount {
  id: string; // act_<account_id>
  account_id: string;
  name: string;
  business: string;
  currency: string;
  account_status: number; // 1 = ACTIVE
  timezone_name: string;
  page_id: string;
}

export interface Campaign {
  id: string;
  account_id: string;
  name: string;
  objective: string;
  status: Status;
  effective_status: EffectiveStatus;
  special_ad_categories: string[];
  buying_type: string;
  updated_time: string;
}

export interface Targeting {
  geo_locations: { countries: string[] };
  age_min?: number;
  age_max?: number;
  interests?: { name: string }[];
  targeting_automation?: { individual_setting?: { device?: 0 | 1 } };
  [k: string]: unknown;
}

export interface AdSet {
  id: string;
  account_id: string;
  campaign_id: string;
  name: string;
  status: Status;
  effective_status: EffectiveStatus;
  daily_budget: string;
  billing_event: string;
  optimization_goal: string;
  bid_strategy: string;
  targeting: Targeting;
  updated_time: string;
}

export interface Creative {
  id: string;
  account_id: string;
  name: string;
  object_story_spec: Record<string, unknown>;
  degrees_of_freedom_spec?: Record<string, unknown>;
}

export interface Ad {
  id: string;
  account_id: string;
  adset_id: string;
  campaign_id: string;
  name: string;
  status: Status;
  effective_status: EffectiveStatus;
  creative: { id: string };
  updated_time: string;
}

export interface InsightRow {
  account_id: string;
  campaign_id?: string;
  spend: string; // major units, e.g. "123.45"
  impressions: string;
  clicks: string;
  date_start: string;
  date_stop: string;
}

export interface Issue {
  code: string;
  message: string;
  account_id?: string;
}
