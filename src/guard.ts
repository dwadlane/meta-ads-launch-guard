import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Issue } from "./types.js";

export const GuardSchema = z.object({
  global_daily_cap_cents: z.number().int().positive(),
  default_account_daily_cap_cents: z.number().int().positive(),
  account_daily_caps: z.record(z.string(), z.number().int().positive()).default({}),
  min_daily_budget_cents: z.number().int().positive().default(500),
  max_budget_change_pct: z.number().positive().max(100).default(30),
  naming: z.object({ campaign_pattern: z.string(), business_codes: z.record(z.string(), z.string()).default({}) }),
  creative: z.object({
    headline_max: z.number().int().positive().default(40),
    body_max: z.number().int().positive().default(125),
    require_https_url: z.boolean().default(true),
    allowed_domains: z.array(z.string()).default([]),
    // v27: Meta may auto-enable Product showcase on creatives. We opt out unless guard.json says otherwise.
    product_extensions_enroll_status: z.enum(["OPT_IN", "OPT_OUT"]).default("OPT_OUT"),
  }),
  targeting: z.object({
    // v27: "Reach more people across other mobile devices" defaults on for eligible Sales ad sets. 0 keeps targeting as planned.
    device_expansion: z.union([z.literal(0), z.literal(1)]).default(0),
  }).default({ device_expansion: 0 }),
  approver: z.object({ min_length: z.number().int().default(3), blocked_names: z.array(z.string()).default([]) }),
  pacing: z.object({ over_ratio: z.number().default(1.25), under_ratio: z.number().default(0.6), min_expected_cents: z.number().int().default(500) }),
});
export type Guard = z.infer<typeof GuardSchema>;

export function loadGuard(path?: string): Guard {
  const file = path ?? process.env.GUARD_FILE ?? resolve(dirname(fileURLToPath(import.meta.url)), "../guard.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`Cannot read guard file ${file}: ${e instanceof Error ? e.message : e}`);
  }
  const parsed = GuardSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`guard.json is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  new RegExp(parsed.data.naming.campaign_pattern); // fail fast on a bad pattern
  return parsed.data;
}

export class GuardError extends Error {
  constructor(message: string, public details: unknown = undefined) {
    super(message);
    this.name = "GuardError";
  }
}

export const accountCap = (g: Guard, accountId: string) => g.account_daily_caps[accountId] ?? g.default_account_daily_cap_cents;

export const money = (c: number, currency = "A$") => `${currency}${(c / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const OBJECTIVE_TOKEN: Record<string, string> = {
  OUTCOME_LEADS: "LEADS", OUTCOME_TRAFFIC: "TRAFFIC", OUTCOME_SALES: "SALES", OUTCOME_AWARENESS: "AWARENESS", OUTCOME_ENGAGEMENT: "ENGAGEMENT",
};

export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export function businessCode(g: Guard, business: string) {
  return g.naming.business_codes[business] ?? business.split(/\s+/).map((w) => w[0]?.toUpperCase() ?? "").join("").slice(0, 5).padEnd(2, "X");
}

export function campaignNameFor(g: Guard, business: string, objective: string, slug: string, yyyymm: string) {
  return `${businessCode(g, business)}_${OBJECTIVE_TOKEN[objective] ?? objective}_${slug}_${yyyymm}`;
}

export function checkName(g: Guard, name: string): Issue | null {
  return new RegExp(g.naming.campaign_pattern).test(name)
    ? null
    : { code: "naming_convention", message: `Campaign name "${name}" does not match the naming convention ${g.naming.campaign_pattern} (example: NSD_LEADS_summer-checkup_202612).` };
}

export interface CreativeInput { headline: string; body?: string; link_url?: string; call_to_action?: string; image_hash?: string }

export function checkCreative(g: Guard, c: CreativeInput, label: string): Issue[] {
  const out: Issue[] = [];
  const h = (c.headline ?? "").trim();
  if (!h) out.push({ code: "creative_headline_missing", message: `${label}: headline is empty.` });
  else if (h.length > g.creative.headline_max) out.push({ code: "creative_headline_too_long", message: `${label}: headline is ${h.length} characters, the limit is ${g.creative.headline_max}.` });
  if (c.body && c.body.length > g.creative.body_max) out.push({ code: "creative_body_too_long", message: `${label}: body is ${c.body.length} characters, the limit is ${g.creative.body_max}.` });
  if (!c.link_url?.trim()) out.push({ code: "creative_url_missing", message: `${label}: link_url is missing, so the ad would have nowhere to send people.` });
  else {
    let u: URL | undefined;
    try { u = new URL(c.link_url); } catch { out.push({ code: "creative_url_invalid", message: `${label}: link_url "${c.link_url}" is not a valid URL.` }); }
    if (u) {
      if (g.creative.require_https_url && u.protocol !== "https:") out.push({ code: "creative_url_not_https", message: `${label}: link_url must be https.` });
      if (g.creative.allowed_domains.length && !g.creative.allowed_domains.some((d) => u!.hostname === d || u!.hostname.endsWith(`.${d}`)))
        out.push({ code: "creative_url_domain", message: `${label}: ${u.hostname} is not on the allowed domain list.` });
    }
  }
  return out;
}

/** Fields the Marketing API rejects on v27.0. We catch them at plan time instead of mid-launch. */
export function checkAudienceFields(a: { lookalike_spec?: Record<string, unknown>; location_spec?: unknown }, label: string): Issue[] {
  const out: Issue[] = [];
  if (a.location_spec !== undefined) out.push({ code: "rejected_field_location_spec", message: `${label}: location_spec is rejected on Marketing API v27.0. Use targeting.geo_locations instead.` });
  if (a.lookalike_spec && "country" in a.lookalike_spec) out.push({ code: "rejected_field_lookalike_country", message: `${label}: lookalike_spec.country is rejected on Marketing API v27.0. Set the country in the lookalike audience itself.` });
  return out;
}

export function checkBudgetChange(g: Guard, oldCents: number, newCents: number): Issue | null {
  if (oldCents <= 0) return null;
  const pct = (Math.abs(newCents - oldCents) / oldCents) * 100;
  return pct > g.max_budget_change_pct + 1e-9
    ? { code: "budget_change_too_large", message: `Changing ${money(oldCents)} to ${money(newCents)} is a ${pct.toFixed(0)}% move. The limit per edit is ${g.max_budget_change_pct}%.` }
    : null;
}

export function checkApprover(g: Guard, name: string | undefined): string {
  const n = (name ?? "").trim();
  if (n.length < g.approver.min_length) throw new GuardError("publish needs an approver: the name of the person who approved this launch.");
  if (g.approver.blocked_names.includes(n.toLowerCase())) throw new GuardError(`"${n}" is not a person. publish needs the name of the human who approved this launch.`);
  return n;
}
