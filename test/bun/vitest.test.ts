import { expect, test } from "bun:test";

test("vitest suite (unit + Workers runtime integration)", () => {
  const r = Bun.spawnSync(["bunx", "vitest", "run"], { stdout: "inherit", stderr: "inherit" });
  expect(r.exitCode).toBe(0);
}, 300_000);
