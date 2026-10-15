import assert from "node:assert/strict";
import test from "node:test";
import {
  branchCanOpenPullRequest,
  remoteCanHostPullRequests,
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
  pullRequestRemote: false,
  pullRequest: noPullRequest,
};

const gitHubRepo: ComposerContextChipsInput = {
  ...plainFolder,
  gitRepo: true,
  pullRequestRemote: true,
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
    "started git chat whose remote is a non-GitHub forge (or no remote): branch only",
    {
      ...gitHubRepo,
      stage: "started",
      pullRequestRemote: false,
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

test("a branch can open a pull request when it is a named branch other than the default", () => {
  const cases: Array<[Parameters<typeof branchCanOpenPullRequest>[0], boolean]> = [
    [undefined, false],
    [{ branch: "main", defaultBranch: "main" }, false],
    [{ branch: "trunk", defaultBranch: "trunk" }, false],
    [{ branch: "fix/login", defaultBranch: "main" }, true],
    // Never pushed: no upstream, still a PR candidate.
    [{ branch: "fix/login" }, true],
    // No remote HEAD recorded: main and master count as the default branch.
    [{ branch: "master" }, false],
    [{ branch: "main" }, false],
    [{ branch: "main", defaultBranch: "trunk" }, true],
    [{ branch: "feature", detached: true }, false],
    [{ branch: "feature", unborn: true }, false],
  ];
  for (const [git, expected] of cases) {
    assert.equal(branchCanOpenPullRequest(git), expected, JSON.stringify(git));
  }
});

test("any remote host may host pull requests except known non-GitHub forges", () => {
  const cases: Array<[string | null | undefined, boolean]> = [
    ["github.com/acme/app", true],
    ["acme.ghe.com/team/app", true],
    ["git.example.com/acme/app", true],
    [null, true],
    [undefined, true],
    ["gitlab.com/acme/app", false],
    ["bitbucket.org/acme/app", false],
    ["codeberg.org/acme/app", false],
    ["dev.azure.com/acme/app", false],
    ["ssh.dev.azure.com/acme/app", false],
    ["acme.visualstudio.com/team/app", false],
    ["git.sr.ht/acme/app", false],
    ["notgitlab.com/acme/app", true],
  ];
  for (const [key, expected] of cases) {
    assert.equal(remoteCanHostPullRequests(key), expected, String(key));
  }
});
