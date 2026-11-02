/**
 * The center keeps an agent's api_url only under the same rule the agent applies to its own
 * config (packages/core/config/config.go apiURLFrom). Both sides read one table (#273).
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { apiOrigin } from "./store.ts";

type Case = { in: string; ok: boolean };

const cases = JSON.parse(
  readFileSync(join(import.meta.dir, "../../../packages/core/config/testdata/api_url_cases.json"), "utf8"),
) as Case[];

test("the shared table is read in full", () => {
  expect(cases.length).toBeGreaterThanOrEqual(40);
  expect(cases.some((c) => c.ok)).toBe(true);
  expect(cases.some((c) => !c.ok)).toBe(true);
});

test.each(cases.map((c) => [JSON.stringify(c.in), c] as const))("api_url %s is taken only when the agent takes it", (_, c) => {
  expect(apiOrigin(c.in) !== null).toBe(c.ok);
});

test("a taken value is kept as its origin", () => {
  expect(apiOrigin("  HTTP://Agent.Example:8792/  ")).toBe("http://agent.example:8792");
  expect(apiOrigin("http://[::1]:8792")).toBe("http://[::1]:8792");
});
