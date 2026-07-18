// Skills settings — Agent Skills (name + description + instructions) the model
// can invoke as tools. Create, edit, enable/disable, remove.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
  Badge,
  Button,
  Dialog,
  Field,
  FieldSet,
  Input,
  Separator,
  Switch,
  Text,
  Textarea,
} from "@glaze/core/components";
import { FolderGit2, Plus, Trash2 } from "lucide-react";
import { skillsApi } from "../../lib/ipc";
import { queryKeys, useDiscoveredSkills, useSkills, useWorkspaces } from "../../lib/queries";
import type { Skill } from "../../lib/types";

/** Folder path of the active workspace, read from localStorage (settings sits outside WorkspaceProvider). */
function useActiveFolderPath(): string | undefined {
  const workspaces = useWorkspaces();
  const activeId = typeof localStorage !== "undefined" ? localStorage.getItem("aiden-agent.workspaceId") : null;
  return workspaces.data?.find((w) => w.id === activeId)?.folderPath;
}

function newSkill(): Skill {
  return { id: `skill-${Date.now().toString(36)}`, name: "", description: "", instructions: "", enabled: true };
}

export function SkillsSettings() {
  const qc = useQueryClient();
  const skills = useSkills();
  const [editing, setEditing] = React.useState<Skill | null>(null);
  const [removing, setRemoving] = React.useState<Skill | null>(null);

  const folderPath = useActiveFolderPath();
  const discovered = useDiscoveredSkills(folderPath);

  const invalidate = () => qc.invalidateQueries({ queryKey: queryKeys.skills });

  const toggle = async (skill: Skill, enabled: boolean) => {
    await skillsApi.save({ ...skill, enabled });
    await invalidate();
  };

  const list = skills.data ?? [];
  const discoveredList = discovered.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <Text variant="strong">Skills</Text>
          <Text variant="small" color="secondary" className="mt-0.5 block">
            Reusable instruction sets the assistant can invoke as tools when a task matches.
          </Text>
        </div>
        <Button variant="filled" size="small" onClick={() => setEditing(newSkill())}>
          <Plus className="size-4" />
          New skill
        </Button>
      </div>

      {list.length === 0 ? (
        <Text variant="small" color="tertiary">
          No skills yet. Create one — e.g. “Code Reviewer” with your review checklist as its instructions.
        </Text>
      ) : (
        <div className="rounded-card border border-separator">
          {list.map((s, i) => (
            <React.Fragment key={s.id}>
              {i > 0 ? <Separator /> : null}
              <div className="flex items-center gap-3 px-3.5 py-3">
                <div className="min-w-0 flex-1">
                  <Text variant="strong" truncate>
                    {s.name || "Untitled skill"}
                  </Text>
                  <Text variant="small" color="tertiary" truncate className="mt-0.5 block">
                    {s.description || "No description"}
                  </Text>
                </div>
                <Button variant="filled" size="small" onClick={() => setEditing(s)}>
                  Edit
                </Button>
                <Switch checked={s.enabled} onCheckedChange={(v) => toggle(s, v)} />
                <Button variant="transparent" size="small" iconOnly aria-label="Delete skill" onClick={() => setRemoving(s)}>
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </React.Fragment>
          ))}
        </div>
      )}

      {discoveredList.length > 0 ? (
        <div className="mt-2 flex flex-col gap-2">
          <div>
            <Text variant="strong">From .agents folders</Text>
            <Text variant="small" color="secondary" className="mt-0.5 block">
              Auto-discovered SKILL.md files in the workspace and your global <code>~/.agents</code>. Always available.
            </Text>
          </div>
          <div className="rounded-card border border-separator">
            {discoveredList.map((s, i) => (
              <React.Fragment key={s.id}>
                {i > 0 ? <Separator /> : null}
                <div className="flex items-center gap-3 px-3.5 py-3">
                  <FolderGit2 className="size-4 shrink-0 text-tertiary" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Text variant="strong" truncate>
                        {s.name}
                      </Text>
                      <Badge color={s.source === "workspace" ? "blue" : "secondary"}>{s.source}</Badge>
                    </div>
                    <Text variant="small" color="tertiary" truncate className="mt-0.5 block">
                      {s.description || s.path}
                    </Text>
                  </div>
                </div>
              </React.Fragment>
            ))}
          </div>
        </div>
      ) : null}

      {editing ? (
        <SkillEditor
          skill={editing}
          open={editing !== null}
          onOpenChange={(open) => !open && setEditing(null)}
          onSaved={invalidate}
        />
      ) : null}

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Delete this skill?"
        description={removing ? `“${removing.name || "Untitled skill"}” will be removed.` : null}
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={async () => {
          if (removing) {
            await skillsApi.remove(removing.id);
            await invalidate();
          }
          setRemoving(null);
        }}
      />
    </div>
  );
}

function SkillEditor({
  skill,
  open,
  onOpenChange,
  onSaved,
}: {
  skill: Skill;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [name, setName] = React.useState(skill.name);
  const [description, setDescription] = React.useState(skill.description);
  const [instructions, setInstructions] = React.useState(skill.instructions);

  React.useEffect(() => {
    if (open) {
      setName(skill.name);
      setDescription(skill.description);
      setInstructions(skill.instructions);
    }
  }, [open, skill]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={skill.name ? `Edit ${skill.name}` : "New skill"}
      size="large"
      confirmLabel="Save"
      confirmDisabled={!name.trim()}
      onConfirm={async () => {
        await skillsApi.save({ ...skill, name: name.trim(), description: description.trim(), instructions });
        onSaved();
        onOpenChange(false);
      }}
    >
      <FieldSet>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Code Reviewer" autoFocus />
        </Field>
        <Field label="Description" description="Shown to the model so it knows when to use this skill.">
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Reviews code for bugs, style, and security issues"
          />
        </Field>
        <Field label="Instructions" description="Loaded when the model invokes the skill." orientation="vertical">
          <Textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="When reviewing code: 1) check for…"
            className="max-h-80 min-h-40"
          />
        </Field>
      </FieldSet>
    </Dialog>
  );
}
