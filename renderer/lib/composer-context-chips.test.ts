import assert from "node:assert/strict";
import test from "node:test";
import {
  branchCanOpenPullRequest,
  isWellKnownGitHubRepository,
  composerContextChips,
  type ComposerContextChips,
  type ComposerContextChipsInput,
} from "./composer-context-chips";

const noPullRequest = { linked: 0, pending: 0, current: false, branchCanOpen: false };

const plainFolder: ComposerContextChipsInput = {
  stage: "draft",
  autoHide: true,
  hasFolder: true,
  accessOff: false,
  gitRepo: false,
  uncommitted: 0,
  machinePicker: false,
  githubRemote: false,
  pullRequest: noPullRequest,
};

const gitHubRepo: ComposerContextChipsInput = {
  ...plainFolder,
  gitRepo: true,
  githubRemote: true,
};

type Row = [name: string, input: ComposerContextChipsInput, expected: ComposerContextChips];

// Expected rows are written out by hand from the plan's chip table.
const rows: Row[] = [
  [
    "plain folder draft: workspace only, no Local label, no PR chip",
    plainFolder,
    { workspace: true, machine: false, branch: false, changesBadge: 0, pullRequest: false, barMode: "full" },
  ],
  [
    "clean git draft: workspace and branch",
    gitHubRepo,
    { workspace: true, machine: false, branch: true, changesBadge: 0, pullRequest: false, barMode: "full" },
  ],
  [
    "dirty git draft: branch carries the change count",
    { ...gitHubRepo, uncommitted: 3 },
    { workspace: true, machine: false, branch: true, changesBadge: 3, pullRequest: false, barMode: "full" },
  ],
  [
    "draft with a paired Mac: machine picker shows",
    { ...plainFolder, machinePicker: true },
    { workspace: true, machine: true, branch: false, changesBadge: 0, pullRequest: false, barMode: "full" },
  ],
  [
    "draft never shows the PR chip, even with a linked PR",
    { ...gitHubRepo, pullRequest: { ...noPullRequest, linked: 1 } },
    { workspace: true, machine: false, branch: true, changesBadge: 0, pullRequest: false, barMode: "full" },
  ],
  [
    "started GitHub chat with a linked PR: summary of branch and PR",
    { ...gitHubRepo, stage: "started", machinePicker: true, pullRequest: { ...noPullRequest, linked: 1 } },
    { workspace: false, machine: false, branch: true, changesBadge: 0, pullRequest: true, barMode: "summary" },
  ],
  [
    "started GitHub chat with a pending create: PR chip shows",
    { ...gitHubRepo, stage: "started", pullRequest: { ...noPullRequest, pending: 1 } },
    { workspace: false, machine: false, branch: true, changesBadge: 0, pullRequest: true, barMode: "summary" },
  ],
  [
    "started GitHub chat whose branch has work to open: PR chip shows",
    { ...gitHubRepo, stage: "started", uncommitted: 2, pullRequest: { ...noPullRequest, branchCanOpen: true } },
    { workspace: false, machine: false, branch: true, changesBadge: 2, pullRequest: true, barMode: "summary" },
  ],
  [
    "started GitHub chat with nothing to open: branch only",
    { ...gitHubRepo, stage: "started" },
    { workspace: false, machine: false, branch: true, changesBadge: 0, pullRequest: false, barMode: "summary" },
  ],
  [
    "started git chat without a GitHub remote: branch only",
    {
      ...gitHubRepo,
      stage: "started",
      githubRemote: false,
      pullRequest: { linked: 1, pending: 1, current: true, branchCanOpen: true },
    },
    { workspace: false, machine: false, branch: true, changesBadge: 0, pullRequest: false, barMode: "summary" },
  ],
  [
    "started chat in a plain folder: bar hidden",
    { ...plainFolder, stage: "started" },
    { workspace: false, machine: false, branch: false, changesBadge: 0, pullRequest: false, barMode: "hidden" },
  ],
  [
    "started chat with access off: no branch, bar hidden",
    { ...gitHubRepo, stage: "started", accessOff: true, uncommitted: 4, pullRequest: { ...noPullRequest, current: true } },
    { workspace: false, machine: false, branch: false, changesBadge: 0, pullRequest: false, barMode: "hidden" },
  ],
  [
    "auto-hide off, started GitHub chat with current PR: full bar",
    { ...gitHubRepo, stage: "started", autoHide: false, pullRequest: { ...noPullRequest, current: true } },
    { workspace: true, machine: false, branch: true, changesBadge: 0, pullRequest: true, barMode: "full" },
  ],
  [
    "auto-hide off, started plain folder: full bar with workspace only",
    { ...plainFolder, stage: "started", autoHide: false },
    { workspace: true, machine: false, branch: false, changesBadge: 0, pullRequest: false, barMode: "full" },
  ],
  [
    "git draft in a folder-less workspace: no branch chip",
    { ...gitHubRepo, hasFolder: false, uncommitted: 1 },
    { workspace: true, machine: false, branch: false, changesBadge: 0, pullRequest: false, barMode: "full" },
  ],
];

for (const [name, input, expected] of rows) {
  test(`composer context chips: ${name}`, () => {
    assert.deepEqual(composerContextChips(input), expected);
  });
}

test("a branch can open a pull request only off the default branch with pushed or unpushed work", () => {
  const cases: Array<[Parameters<typeof branchCanOpenPullRequest>[0], boolean]> = [
    [undefined, false],
    [{ branch: "main", defaultBranch: "main", upstream: "origin/main", ahead: 2 }, false],
    [{ branch: "trunk", defaultBranch: "trunk", upstream: "origin/trunk" }, false],
    [{ branch: "fix/login", defaultBranch: "main", upstream: "origin/fix/login", ahead: 0 }, true],
    [{ branch: "fix/login", defaultBranch: "main" }, false],
    [{ branch: "fix/login", defaultBranch: "main", ahead: 1 }, true],
    // No remote HEAD recorded: main and master count as the default branch.
    [{ branch: "master", upstream: "origin/master", ahead: 1 }, false],
    [{ branch: "main", upstream: "origin/main" }, false],
    [{ branch: "feature", upstream: "origin/feature" }, true],
    [{ branch: "feature", detached: true, upstream: "origin/feature" }, false],
    [{ branch: "feature", unborn: true, ahead: 1 }, false],
  ];
  for (const [git, expected] of cases) {
    assert.equal(branchCanOpenPullRequest(git), expected, JSON.stringify(git));
  }
});

test("only github.com and GHE.com repository keys count as GitHub without PR evidence", () => {
  assert.equal(isWellKnownGitHubRepository("github.com/acme/app"), true);
  assert.equal(isWellKnownGitHubRepository("acme.ghe.com/team/app"), true);
  assert.equal(isWellKnownGitHubRepository("gitlab.com/acme/app"), false);
  assert.equal(isWellKnownGitHubRepository("git.example.com/acme/app"), false);
  assert.equal(isWellKnownGitHubRepository("notghe.com/acme/app"), false);
  assert.equal(isWellKnownGitHubRepository(undefined), false);
});
