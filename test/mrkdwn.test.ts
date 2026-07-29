import assert from "node:assert/strict";
import { test } from "node:test";
import { splitMessage, toMrkdwn } from "../src/transports/slack/mrkdwn.js";

test("bold becomes single asterisks", () => {
  assert.equal(toMrkdwn("**loud**"), "*loud*");
  assert.equal(toMrkdwn("__loud__"), "*loud*");
});

test("italic becomes underscores", () => {
  // The dangerous case: *x* means bold in CommonMark, italic in Slack.
  assert.equal(toMrkdwn("*quiet*"), "_quiet_");
});

test("bold is not re-read as italic", () => {
  assert.equal(toMrkdwn("**both** and *one*"), "*both* and _one_");
});

test("links become Slack link syntax", () => {
  assert.equal(
    toMrkdwn("[the console](https://example.com/a?b=1)"),
    "<https://example.com/a?b=1|the console>",
  );
  assert.equal(toMrkdwn("![shot](https://img/x.png)"), "<https://img/x.png|shot>");
});

test("headings become bold lines", () => {
  assert.equal(toMrkdwn("## Findings"), "*Findings*");
});

test("bullets become bullet characters", () => {
  assert.equal(toMrkdwn("- one\n- two"), "• one\n• two");
});

test("strikethrough collapses to one tilde", () => {
  assert.equal(toMrkdwn("~~gone~~"), "~gone~");
});

test("fenced code is left exactly alone", () => {
  const input = "```\naws s3 ls --profile *prod* # **note**\n```";
  assert.equal(toMrkdwn(input), input);
});

test("inline code is left exactly alone", () => {
  assert.equal(toMrkdwn("run `ls *.ts` now"), "run `ls *.ts` now");
});

test("Slack control characters are escaped", () => {
  assert.equal(toMrkdwn("a < b & c"), "a &lt; b &amp; c");
});

test("blockquotes survive escaping", () => {
  assert.equal(toMrkdwn("> quoted"), "> quoted");
});

test("tables become code blocks so columns stay aligned", () => {
  const table = ["| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n");
  const out = toMrkdwn(table);
  assert.ok(out.startsWith("```"), `expected a fence, got: ${out}`);
  assert.ok(out.includes("| 1 | 2 |"), "table rows should be preserved verbatim");
});

test("short messages are not split", () => {
  assert.deepEqual(splitMessage("hello"), ["hello"]);
});

test("splitting never leaves a fence open", () => {
  const body = ["```", ...Array.from({ length: 400 }, (_, i) => `line ${i}`), "```"].join("\n");
  const chunks = splitMessage(body, 500);

  assert.ok(chunks.length > 1, "expected the body to be split");
  for (const chunk of chunks) {
    const fences = (chunk.match(/```/g) ?? []).length;
    assert.equal(fences % 2, 0, `chunk has an unbalanced fence:\n${chunk}`);
  }
});

test("every chunk respects the limit", () => {
  const body = Array.from({ length: 300 }, (_, i) => `line number ${i}`).join("\n");
  for (const chunk of splitMessage(body, 400)) {
    assert.ok(chunk.length <= 400, `chunk too long: ${chunk.length}`);
  }
});
