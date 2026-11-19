import assert from "node:assert/strict";
import test from "node:test";
import { axeProblems, type AxeExclusion } from "./axe-gate";

const contrast = {
  id: "color-contrast",
  impact: "serious",
  help: "Elements must meet minimum color contrast ratio thresholds",
  helpUrl: "https://dequeuniversity.com/rules/axe/4.14/color-contrast",
  nodes: [
    { target: [".muted-label"], failureSummary: "Fix any of the following:\n  Element has insufficient color contrast" },
    { target: ["#radix-_r3_ > .hint"] },
  ],
};
const label = {
  id: "button-name",
  impact: "critical",
  help: "Buttons must have discernible text",
  helpUrl: "https://dequeuniversity.com/rules/axe/4.14/button-name",
  nodes: [{ target: ["iframe#preview", "button.close"] }],
};

test("lists every failing node with rule, impact, target, help and summary", () => {
  const problems = axeProblems("palette", [contrast, label], []);
  assert.equal(problems.length, 3);
  assert.equal(
    problems[0],
    "[palette] color-contrast (serious) at .muted-label: Elements must meet minimum color contrast ratio thresholds" +
      " | Fix any of the following: Element has insufficient color contrast" +
      " | https://dequeuniversity.com/rules/axe/4.14/color-contrast",
  );
  assert.match(problems[2], /^\[palette\] button-name \(critical\) at iframe#preview >> button\.close: /u);
});

test("an exclusion excuses only its own rule and target on its own surface", () => {
  const exclusions: AxeExclusion[] = [
    { surface: "palette", rule: "color-contrast", target: ".muted-label", reason: "token" },
    { surface: "palette", rule: "color-contrast", target: /^#radix-\S+ > \.hint$/u, reason: "token" },
  ];
  assert.deepEqual(axeProblems("palette", [contrast], exclusions), []);
  // The same violation on another surface is not excused, and those exclusions are not stale there.
  assert.equal(axeProblems("settings", [contrast], exclusions).length, 2);
  // A matching target under a different rule is still reported.
  const sameTarget = { ...label, nodes: [{ target: [".muted-label"] }] };
  assert.equal(axeProblems("palette", [contrast, sameTarget], exclusions).length, 1);
});

test("an exclusion that no longer matches fails the audit so the list only shrinks", () => {
  const exclusions: AxeExclusion[] = [
    { surface: "palette", rule: "color-contrast", target: ".muted-label", reason: "token" },
    { surface: "palette", rule: "aria-required-children", target: "[role=listbox]", reason: "fixed since" },
  ];
  const problems = axeProblems("palette", [{ ...contrast, nodes: [contrast.nodes[0]] }], exclusions);
  assert.deepEqual(problems, [
    "[palette] stale exclusion: aria-required-children at [role=listbox] no longer fails; delete it from AXE_EXCLUSIONS",
  ]);
});
