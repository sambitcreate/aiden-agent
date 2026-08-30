import assert from "node:assert/strict";
import test from "node:test";
import type { CommandId } from "../shared/keybindings.js";
import { SLASH_COMMANDS } from "../shared/slash-commands.js";
import {
  attemptSlashCommandAction,
  executeSlashCommandAction,
  slashCommandAvailability,
  validateSlashCommandArgument,
  type SlashCommandActionHandlers,
} from "./slash-command-actions.js";

const command = (name: string) => {
  const result = SLASH_COMMANDS.find((entry) => entry.name === name);
  assert.ok(result);
  return result;
};

const context = {
  canExecuteCommand: () => true,
  hasChat: true,
  hasLatestAssistantResponse: true,
  hasWorkspace: true,
  hasCompletedTurn: true,
  hasAuthenticatedProvider: true,
  hasManagedWorktreeFlow: true,
  idle: true,
  payloadAfterToken: false,
};

test("slash availability combines the dispatcher with composer-specific state", () => {
  assert.deepEqual(slashCommandAvailability(command("copy"), context), { available: true });
  assert.match(
    slashCommandAvailability(command("copy"), {
      ...context,
      hasLatestAssistantResponse: false,
    }).reason ?? "",
    /no assistant response/iu,
  );
  assert.match(
    slashCommandAvailability(command("new"), { ...context, payloadAfterToken: true }).reason ?? "",
    /clear the draft/iu,
  );
  assert.match(
    slashCommandAvailability(command("settings"), {
      ...context,
      payloadAfterToken: true,
    }).reason ?? "",
    /before navigating/iu,
  );
  for (const name of ["new", "settings", "providers"]) {
    assert.match(
      slashCommandAvailability(command(name), {
        ...context,
        navigationBlockedReason: "Navigation is blocked.",
      }).reason ?? "",
      /navigation is blocked/iu,
    );
  }
  assert.deepEqual(
    slashCommandAvailability(command("resume"), {
      ...context,
      navigationBlockedReason: "Navigation is blocked.",
    }),
    { available: true },
  );
  assert.match(
    slashCommandAvailability(command("access"), {
      ...context,
      composerControlBlockedReason: "Access is busy.",
    }).reason ?? "",
    /access is busy/iu,
  );
  assert.match(
    slashCommandAvailability(command("environment"), {
      ...context,
      environmentBlockedReason: "Git is busy.",
    }).reason ?? "",
    /git is busy/iu,
  );
  assert.match(
    slashCommandAvailability(command("terminal"), {
      ...context,
      canExecuteCommand: () => false,
    }).reason ?? "",
    /unavailable/iu,
  );
  assert.match(
    slashCommandAvailability(command("fork"), {
      ...context,
      hasCompletedTurn: false,
    }).reason ?? "",
    /complete an assistant turn/iu,
  );
  assert.match(
    slashCommandAvailability(command("clone"), { ...context, idle: false }).reason ?? "",
    /response or approval/iu,
  );
  assert.match(
    slashCommandAvailability(command("export"), {
      ...context,
      idle: false,
      idleBlockedReason: "Finish loading attachments.",
    }).reason ?? "",
    /loading attachments/iu,
  );
  assert.match(
    slashCommandAvailability(command("clone"), {
      ...context,
      chatCloneBlockedReason: "Too many messages to clone.",
    }).reason ?? "",
    /too many messages/iu,
  );
  assert.match(
    slashCommandAvailability(command("logout"), {
      ...context,
      hasAuthenticatedProvider: false,
    }).reason ?? "",
    /no authenticated provider/iu,
  );
  assert.match(
    slashCommandAvailability(command("worktree"), {
      ...context,
      hasManagedWorktreeFlow: false,
    }).reason ?? "",
    /not an available Git worktree source/iu,
  );
  assert.match(
    slashCommandAvailability(command("worktree"), {
      ...context,
      hasAttachmentsOrSelectedSkill: true,
    }).reason ?? "",
    /remove draft attachments/iu,
  );
  assert.match(
    slashCommandAvailability(command("visualize"), {
      ...context,
      hasWorkspaceArtifactAccess: false,
    }).reason ?? "",
    /allow workspace access/iu,
  );
  assert.match(
    slashCommandAvailability(command("clone"), {
      ...context,
      payloadAfterToken: true,
    }).reason ?? "",
    /clear the draft/iu,
  );
});

test("slash action adapters route canonical actions without interpreting draft text", () => {
  const calls: string[] = [];
  const handlers: SlashCommandActionHandlers = {
    executeCommand: (id: CommandId) => (calls.push(`command:${id}`), true),
    openSettings: (section) => {
      calls.push(`settings:${section ?? "root"}`);
    },
    requestRename: (title) => {
      calls.push(`rename:${title ?? "dialog"}`);
    },
    copyLatestResponse: () => {
      calls.push("copy");
    },
    openReview: () => {
      calls.push("review");
    },
    openAccess: () => {
      calls.push("access");
    },
    openFork: () => {
      calls.push("fork");
    },
    cloneChat: () => {
      calls.push("clone");
    },
    exportChat: () => {
      calls.push("export");
    },
    openSessionDetails: () => calls.push("session"),
    openLogout: () => calls.push("logout"),
    openWorktree: (branchName) => {
      calls.push(`worktree:${branchName ?? "picker"}`);
    },
  };

  executeSlashCommandAction(command("model"), " ignored", handlers);
  executeSlashCommandAction(command("hotkeys"), "", handlers);
  executeSlashCommandAction(command("name"), "  A better title  ", handlers);
  executeSlashCommandAction(command("copy"), "", handlers);
  executeSlashCommandAction(command("review"), "", handlers);
  executeSlashCommandAction(command("access"), "", handlers);
  executeSlashCommandAction(command("theme"), "", handlers);
  executeSlashCommandAction(command("fork"), "", handlers);
  executeSlashCommandAction(command("clone"), "", handlers);
  executeSlashCommandAction(command("export"), "", handlers);
  executeSlashCommandAction(command("session"), "", handlers);
  executeSlashCommandAction(command("logout"), "", handlers);
  executeSlashCommandAction(command("worktree"), " feature/phase-four ", handlers);

  assert.deepEqual(calls, [
    "command:model.change",
    "settings:shortcut",
    "rename:A better title",
    "copy",
    "review",
    "access",
    "command:settings.search",
    "fork",
    "clone",
    "export",
    "session",
    "logout",
    "worktree:feature/phase-four",
  ]);
});

test("argument actions validate bounded single-line titles before dispatch", () => {
  assert.deepEqual(validateSlashCommandArgument(command("name"), "  Better title  "), {
    valid: true,
    value: "Better title",
  });
  assert.deepEqual(validateSlashCommandArgument(command("name"), "   "), { valid: true });
  assert.match(
    validateSlashCommandArgument(command("name"), "bad\ntitle").reason ?? "",
    /one line/iu,
  );
  assert.equal(validateSlashCommandArgument(command("name"), "x".repeat(121)).valid, false);
  assert.deepEqual(
    validateSlashCommandArgument(command("worktree"), " feature/session-commands "),
    { valid: true, value: "feature/session-commands" },
  );
  for (const invalid of ["bad branch", "../escape", "refs//double", "branch.lock", "topic@{1}"]) {
    assert.equal(validateSlashCommandArgument(command("worktree"), invalid).valid, false);
  }
});

test("action attempts distinguish immediate UI dispatch from delayed clipboard work", async () => {
  const handlers: SlashCommandActionHandlers = {
    executeCommand: () => true,
    openSettings: () => undefined,
    requestRename: () => undefined,
    copyLatestResponse: async () => undefined,
    openReview: () => undefined,
    openAccess: () => undefined,
  };
  assert.deepEqual(attemptSlashCommandAction(command("model"), "", handlers), {
    kind: "sync",
    handled: true,
  });
  assert.equal(attemptSlashCommandAction(command("name"), "", handlers).kind, "sync");
  assert.equal(attemptSlashCommandAction(command("access"), "", handlers).kind, "sync");
  assert.equal(attemptSlashCommandAction(command("resume"), "", handlers).kind, "sync");

  const clipboard = attemptSlashCommandAction(command("copy"), "", handlers);
  assert.equal(clipboard.kind, "async");
  if (clipboard.kind === "async") {
    assert.deepEqual(await clipboard.completion, { handled: true });
  }
});

test("visualize only commits the slash draft after the composer accepts the send", async () => {
  const rejected = attemptSlashCommandAction(command("visualize"), "", {
    executeCommand: () => true,
    openSettings: () => undefined,
    requestRename: () => undefined,
    copyLatestResponse: () => undefined,
    openReview: () => undefined,
    openAccess: () => undefined,
    submitComposerInstruction: async () => false,
  });
  assert.equal(rejected.kind, "async");
  if (rejected.kind === "async") {
    assert.deepEqual(await rejected.completion, { handled: false });
  }

  const accepted = executeSlashCommandAction(command("visualize"), "  chart sales  ", {
    executeCommand: () => true,
    openSettings: () => undefined,
    requestRename: () => undefined,
    copyLatestResponse: () => undefined,
    openReview: () => undefined,
    openAccess: () => undefined,
    submitComposerInstruction: async (instruction, prompt) =>
      instruction === "visualize" && prompt === "chart sales",
  });
  assert.equal(accepted instanceof Promise, true);
  assert.equal(await accepted, true);
});

test("failed async actions return a controlled failure before the composer commits", async () => {
  const failure = new Error("Clipboard access was denied.");
  const handlers: SlashCommandActionHandlers = {
    executeCommand: () => true,
    openSettings: () => undefined,
    requestRename: () => undefined,
    copyLatestResponse: async () => {
      throw failure;
    },
    openReview: () => undefined,
    openAccess: () => undefined,
  };
  const attempt = attemptSlashCommandAction(command("copy"), "", handlers);
  assert.equal(attempt.kind, "async");
  if (attempt.kind === "async") {
    assert.deepEqual(await attempt.completion, {
      handled: false,
      error: failure,
    });
  }
});

test("visualize is idle-workspace and submits a composer instruction", () => {
  const visualize = command("visualize");
  assert.equal(visualize.availability, "idle-workspace");
  assert.equal(visualize.argument, "optional-prompt");
  assert.deepEqual(visualize.action, { kind: "composer-instruction", instruction: "visualize" });
  assert.deepEqual(slashCommandAvailability(visualize, context), { available: true });
  assert.match(
    slashCommandAvailability(visualize, { ...context, hasWorkspace: false }).reason ?? "",
    /workspace first/iu,
  );
  assert.match(
    slashCommandAvailability(visualize, { ...context, idle: false }).reason ?? "",
    /current response/iu,
  );
  assert.deepEqual(validateSlashCommandArgument(visualize, "draw a DAG"), {
    valid: true,
    value: "draw a DAG",
  });
  assert.equal(validateSlashCommandArgument(visualize, "bad\nprompt").valid, false);

  const submitted: unknown[] = [];
  const handlers: SlashCommandActionHandlers = {
    executeCommand: () => true,
    openSettings: () => undefined,
    requestRename: () => undefined,
    copyLatestResponse: () => undefined,
    openReview: () => undefined,
    openAccess: () => undefined,
    submitComposerInstruction: (instruction, prompt) => {
      submitted.push([instruction, prompt]);
      return true;
    },
  };
  assert.equal(executeSlashCommandAction(visualize, "  chart sales  ", handlers), true);
  assert.deepEqual(submitted, [["visualize", "chart sales"]]);
});
