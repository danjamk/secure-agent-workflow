import { env, SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("/health returns the build id", async () => {
  const response = await SELF.fetch("https://orchestrator.test/health");
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("1.2.3+abc1234");
});

it.each([
  ["GET", "/webhook"],
  ["POST", "/health"],
  ["GET", "/"],
])("%s %s is not found", async (method, path) => {
  const response = await SELF.fetch(`https://orchestrator.test${path}`, { method });
  expect(response.status).toBe(404);
});

it("a delivery id can be claimed once, and again after it's forgotten", async () => {
  const log = env.DELIVERY_LOG.getByName("test");
  expect(await log.claim("a")).toBe(true);
  expect(await log.claim("a")).toBe(false);
  expect(await log.claim("b")).toBe(true);
  await log.forget("a");
  expect(await log.claim("a")).toBe(true);
});

it("an issue holds one active run, and only that run can release it", async () => {
  const log = env.DELIVERY_LOG.getByName("issue-lock-test");
  expect(await log.claimIssue("1#1", "run-a")).toBe(true);
  expect(await log.claimIssue("1#1", "run-b")).toBe(false);
  await log.releaseIssue("1#1", "run-b");
  expect(await log.claimIssue("1#1", "run-b")).toBe(false);
  await log.releaseIssue("1#1", "run-a");
  expect(await log.claimIssue("1#1", "run-b")).toBe(true);
  expect(await log.claimIssue("2#1", "run-c")).toBe(true);
});
