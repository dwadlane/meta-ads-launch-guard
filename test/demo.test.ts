import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runDemo } from "../examples/demo.js";

describe("demo", () => {
  it("plays the whole story and matches the committed output", async () => {
    const md = await runDemo();
    expect(md).toMatch(/\*\*1 blocked\*\*/);
    expect(md).toMatch(/0 created, 12 replayed/);
    expect(md).toMatch(/Approved by Sam Rivera, 12 campaigns active/);
    expect(md).toMatch(/\*\*2 flagged\*\*/);
    expect(md).toBe(readFileSync(new URL("../examples/demo-output.md", import.meta.url), "utf8"));
  });
});
