import { describe, expect, it } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuardError, accountCap, campaignNameFor, checkApprover, checkAudienceFields, checkBudgetChange, checkCreative, checkName, loadGuard } from "../src/guard.js";

const g = loadGuard();

describe("guard.json", () => {
  it("loads, and per-account caps beat the default", () => {
    expect(accountCap(g, "act_7100000002")).toBe(12000);
    expect(accountCap(g, "act_7100000001")).toBe(g.default_account_daily_cap_cents);
    expect(g.creative.product_extensions_enroll_status).toBe("OPT_OUT");
    expect(g.targeting.device_expansion).toBe(0);
  });
  it("rejects a broken file with a plain message", () => {
    const f = join(mkdtempSync(join(tmpdir(), "guard-")), "g.json");
    writeFileSync(f, JSON.stringify({ global_daily_cap_cents: -5 }));
    expect(() => loadGuard(f)).toThrow(/guard.json is invalid/);
  });
});

describe("naming convention", () => {
  it("builds a compliant name", () => {
    const n = campaignNameFor(g, "Northside Dental", "OUTCOME_LEADS", "summer-checkup", "202612");
    expect(n).toBe("NSD_LEADS_summer-checkup_202612");
    expect(checkName(g, n)).toBeNull();
  });
  it("flags a name that breaks the convention", () => {
    expect(checkName(g, "Summer Sale!!")?.code).toBe("naming_convention");
  });
});

describe("creative check", () => {
  it("passes a clean creative", () => {
    expect(checkCreative(g, { headline: "Free first visit", link_url: "https://x.com/a" }, "C1")).toEqual([]);
  });
  it("flags a headline over the limit, a missing URL and an http URL", () => {
    expect(checkCreative(g, { headline: "x".repeat(41), link_url: "https://x.com" }, "C1").map((i) => i.code)).toEqual(["creative_headline_too_long"]);
    expect(checkCreative(g, { headline: "ok" }, "C1").map((i) => i.code)).toEqual(["creative_url_missing"]);
    expect(checkCreative(g, { headline: "ok", link_url: "http://x.com" }, "C1").map((i) => i.code)).toEqual(["creative_url_not_https"]);
  });
});

describe("budget change limit", () => {
  it("allows 30 percent and refuses 31", () => {
    expect(checkBudgetChange(g, 10000, 13000)).toBeNull();
    expect(checkBudgetChange(g, 10000, 7000)).toBeNull();
    expect(checkBudgetChange(g, 10000, 13100)?.code).toBe("budget_change_too_large");
  });
});

describe("approver", () => {
  it("needs a real person's name", () => {
    expect(checkApprover(g, " Sam Rivera ")).toBe("Sam Rivera");
    expect(() => checkApprover(g, "")).toThrow(GuardError);
    expect(() => checkApprover(g, "Claude")).toThrow(/not a person/);
  });
});

describe("v27 rejected fields", () => {
  it("flags location_spec and lookalike_spec.country", () => {
    expect(checkAudienceFields({ location_spec: {} }, "A").map((i) => i.code)).toEqual(["rejected_field_location_spec"]);
    expect(checkAudienceFields({ lookalike_spec: { country: "AU", ratio: 0.01 } }, "A").map((i) => i.code)).toEqual(["rejected_field_lookalike_country"]);
    expect(checkAudienceFields({ lookalike_spec: { ratio: 0.01 } }, "A")).toEqual([]);
  });
});
