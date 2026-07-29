import assert from "node:assert/strict";
import { test } from "node:test";
import { ApprovalRegistry } from "../src/transports/slack/approvals.js";
import type { ApprovalRequest } from "../src/core/types.js";

const REQUEST: ApprovalRequest = {
  tool: "Bash",
  detail: "systemctl restart nginx",
  reason: "This command could change something.",
};

const never = () => {
  throw new Error("should not have expired");
};

test("approving resolves the waiting turn", async () => {
  const registry = new ApprovalRegistry();
  const { id, decision } = registry.open(REQUEST, 10_000, never);

  registry.settle(id, { approved: true, by: "<@U1>" });

  const result = await decision;
  assert.equal(result.approved, true);
  assert.equal(result.by, "<@U1>");
});

test("denying resolves with the reason the agent will be told", async () => {
  const registry = new ApprovalRegistry();
  const { id, decision } = registry.open(REQUEST, 10_000, never);

  registry.settle(id, { approved: false, by: "<@U1>", message: "Denied by <@U1>." });

  const result = await decision;
  assert.equal(result.approved, false);
  assert.equal(result.approved === false && result.message, "Denied by <@U1>.");
});

test("an unanswered request denies itself rather than hanging the turn", async () => {
  const registry = new ApprovalRegistry();
  let expired = false;

  // The agent is blocked mid-turn while this is outstanding, so the timer is
  // load-bearing: without it the conversation would never come back.
  const { decision } = registry.open(REQUEST, 20, () => {
    expired = true;
  });

  const result = await decision;
  assert.equal(result.approved, false);
  assert.equal(expired, true, "the caller should be told so it can update the UI");
});

test("a second click is ignored", async () => {
  const registry = new ApprovalRegistry();
  const { id, decision } = registry.open(REQUEST, 10_000, never);

  const first = registry.settle(id, { approved: true });
  const second = registry.settle(id, { approved: false });

  assert.ok(first, "the first click settles the request");
  assert.equal(second, undefined, "the second has nothing left to settle");
  assert.equal((await decision).approved, true, "the first answer stands");
});

test("an unknown id settles nothing", () => {
  const registry = new ApprovalRegistry();
  // What a button clicked after a restart looks like.
  assert.equal(registry.settle("no-such-id", { approved: true }), undefined);
});

test("settling returns where the question was asked, so it can be edited", () => {
  const registry = new ApprovalRegistry();
  const { id } = registry.open(REQUEST, 10_000, never);

  registry.locate(id, "C123", "1699.0001");
  const entry = registry.settle(id, { approved: true });

  assert.equal(entry?.channel, "C123");
  assert.equal(entry?.messageTs, "1699.0001");
  assert.equal(entry?.request.detail, REQUEST.detail);
});

test("shutdown denies anything outstanding", async () => {
  const registry = new ApprovalRegistry();
  const { decision } = registry.open(REQUEST, 10_000, never);

  registry.drain();

  const result = await decision;
  assert.equal(result.approved, false, "a pending approval must not survive as a yes");
});

test("timing out does not fire after an answer", async () => {
  const registry = new ApprovalRegistry();
  const { id, decision } = registry.open(REQUEST, 20, never);

  registry.settle(id, { approved: true });
  await decision;

  // If the timer were still armed, `never` would throw here.
  await new Promise((resolve) => setTimeout(resolve, 50));
});
