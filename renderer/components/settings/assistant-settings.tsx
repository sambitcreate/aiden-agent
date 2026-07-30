import { useNavigate } from "@tanstack/react-router";
import { Badge, Button, Callout, Field, FieldSet, Text } from "../ui";
import { useShortcuts } from "../../lib/queries";
import { prettyAccelerator } from "../../shared/keybindings";

function HowAidenWorks() {
  return (
    <FieldSet title="How Aiden works">
      <Field
        label="Chat model"
        description="Interactive Aiden chats use the provider and model selected in the main composer."
      >
        <Badge>Follows composer</Badge>
      </Field>
      <Field
        label="Conversation history"
        description="Aiden conversations are stored on this Mac in a private assistant workspace."
      >
        <Badge>On this Mac</Badge>
      </Field>
      <Field
        label="Access"
        description="Aiden can list automations and propose new read-only Ask Aiden tasks with your confirmation. It still cannot inspect live settings or projects, edit files, run commands, or use connected tools."
      >
        <Badge>Automations only</Badge>
      </Field>
      <Field
        label="Background suggestions"
        description="Project monitoring and proactive nudges are not active in this build, so background controls are not shown yet."
      >
        <Badge>Not active</Badge>
      </Field>
    </FieldSet>
  );
}

export function AssistantSettings() {
  const navigate = useNavigate();
  const shortcuts = useShortcuts();
  const binding = shortcuts.data?.effective["assistant.open"] ?? null;
  const runtime = shortcuts.data?.global.find((item) => item.commandId === "assistant.open");

  if (shortcuts.isError) {
    return (
      <>
        <Callout
          role="alert"
          color="red"
          className="mb-4 flex-row items-center justify-between gap-4"
        >
          <div>
            <Text variant="strong">Aiden shortcut is unavailable</Text>
            <Text as="p" variant="small" color="secondary" className="mt-0.5">
              Retry before reviewing the global shortcut.
            </Text>
          </div>
          <Button size="small" onClick={() => void shortcuts.refetch()}>
            Retry
          </Button>
        </Callout>
        <HowAidenWorks />
      </>
    );
  }

  if (shortcuts.isLoading || !shortcuts.data) {
    return (
      <>
        <FieldSet title="Open Aiden">
          <Field label="Global shortcut" description="Checking the saved global shortcut.">
            <Badge>Checking…</Badge>
          </Field>
        </FieldSet>
        <HowAidenWorks />
      </>
    );
  }

  return (
    <>
      <FieldSet title="Open Aiden">
        <Field
          label="Global shortcut"
          description="Open the Aiden dock from anywhere and move focus to its composer."
        >
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Badge
              color={
                runtime?.state === "active"
                  ? "green"
                  : runtime?.state === "unavailable"
                    ? "red"
                    : undefined
              }
            >
              {runtime?.state === "active"
                ? "Active"
                : runtime?.state === "unavailable"
                  ? "Unavailable"
                  : "Off"}
            </Badge>
            <Text variant="small-strong">{prettyAccelerator(binding)}</Text>
            <Button
              size="small"
              variant="filled"
              onClick={() => void navigate({ to: "/settings", search: { section: "shortcut" } })}
            >
              Manage shortcuts
            </Button>
          </div>
        </Field>
      </FieldSet>
      <HowAidenWorks />
    </>
  );
}
