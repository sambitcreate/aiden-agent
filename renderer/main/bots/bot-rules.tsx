import * as React from "react";
import { Ellipsis, LockKeyhole, Plus, RotateCcw } from "lucide-react";
import {
  Button,
  Callout,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  FieldLabel,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  Text,
} from "../../components/ui";
import type { BotDefinition } from "../../shared/bots";
import {
  BOT_RULE_TEXT_MAX_CHARS,
  botRuleBehaviorLabel,
  botRuleLabel,
  isBotRuleBehavior,
  type BotRule,
  type BotRuleBehavior,
} from "../../shared/bot-rules";
import { useBotRuleChange, useBotRules, type BotRuleChangeOutcome } from "./use-bot-rules";

type RuleBot = Pick<BotDefinition, "id" | "name">;

const BEHAVIORS: readonly BotRuleBehavior[] = ["ask", "hand_off"];

const ROW_CLASS =
  "relative flex w-full min-w-0 items-center gap-3 px-4 py-3 after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-separator";
const ACTION_ROW_CLASS =
  "relative flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left outline-none transition-colors duration-150 hover:bg-list-hover focus-visible:bg-list-hover focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring disabled:opacity-45 motion-reduce:transition-none";

/** How a rule reads in the editor: built-in rules by their label, the person's own as "When Ada wants to …". */
function ruleTitle(bot: RuleBot, rule: BotRule): string {
  return rule.actionClass === undefined ? `When ${bot.name} wants to ${rule.text ?? ""}` : botRuleLabel(rule);
}

function behaviorDescription(bot: RuleBot, behavior: BotRuleBehavior): string {
  return behavior === "hand_off"
    ? `${bot.name} stops and hands you the step to do yourself.`
    : `${bot.name} asks you before it goes ahead.`;
}

/**
 * The Bot's rules (plan §6.4): one grouped card with the locked rules, the
 * built-in rules and the person's own, each with what the Bot does. Rules only
 * make a Bot stricter; main enforces them at every tool call.
 */
export function BotRules({ bot }: { bot: RuleBot }) {
  const rules = useBotRules(bot.id);
  const { apply, busy } = useBotRuleChange(bot.id);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [editing, setEditingState] = React.useState<BotRule | "new" | null>(null);
  const [editorSession, setEditorSession] = React.useState(0);
  const setEditing = (next: BotRule | "new" | null) => {
    if (next !== null) setEditorSession((value) => value + 1);
    setEditingState(next);
  };

  const change = async (...args: Parameters<typeof apply>) => {
    setProblem(null);
    setProblem(await apply(...args));
  };

  const titleId = `rules-${bot.id}`;
  const list = rules.data?.rules ?? [];

  return (
    <section aria-labelledby={titleId} className="settings-group mb-7">
      <h2 id={titleId} className="settings-group-title mb-3 px-4 text-large-strong text-primary">
        Rules
      </h2>
      {problem ? (
        <Callout color="red" role="alert" className="mb-3">
          <Text variant="small-strong" color="red">
            {problem}
          </Text>
        </Callout>
      ) : null}
      <div className="settings-group-card overflow-hidden rounded-card bg-well">
        {rules.isLoading ? (
          <div role="status" aria-label="Loading rules" className={ROW_CLASS}>
            <span className="grid gap-2">
              <span className="h-3 w-48 max-w-full rounded-full bg-control motion-safe:animate-pulse" />
              <span className="h-2.5 w-24 rounded-full bg-control motion-safe:animate-pulse" />
            </span>
          </div>
        ) : rules.isError ? (
          <div role="alert" className={`${ROW_CLASS} flex-wrap justify-between`}>
            <Text as="p" variant="small" color="secondary">
              Aiden couldn’t load {bot.name}’s rules.
            </Text>
            <Button size="small" variant="filled" onClick={() => void rules.refetch()}>
              <RotateCcw /> Try again
            </Button>
          </div>
        ) : (
          <ul aria-label="Rules">
            {list.map((rule) => (
              <li key={rule.id}>
                <RuleRow
                  bot={bot}
                  rule={rule}
                  busy={busy}
                  onBehavior={(behavior) =>
                    void change(
                      rule.actionClass === undefined
                        ? { type: "edit_custom", ruleId: rule.id, behavior }
                        : { type: "set_behavior", ruleId: rule.id, behavior },
                    )
                  }
                  onEdit={() => setEditing(rule)}
                  onDelete={() => void change({ type: "remove_custom", ruleId: rule.id })}
                />
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className={ACTION_ROW_CLASS}
          disabled={!rules.data}
          onClick={() => {
            setProblem(null);
            setEditing("new");
          }}
        >
          <Plus aria-hidden="true" className="size-4 shrink-0 text-secondary" />
          <span className="text-regular text-primary">Add a rule</span>
        </button>
      </div>
      <Text as="p" variant="small" color="secondary" className="mt-2 px-4 text-pretty">
        Rules don’t cover shell commands; the Shell setting does.
      </Text>
      <BotRuleEditor
        // Each opening starts a fresh form from the rule it edits (or a blank one).
        key={editorSession}
        bot={bot}
        {...(editing && typeof editing === "object" ? { rule: editing } : {})}
        open={editing !== null}
        busy={busy}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        onSave={apply}
      />
    </section>
  );
}

function RuleRow({
  bot,
  rule,
  busy,
  onBehavior,
  onEdit,
  onDelete,
}: {
  bot: RuleBot;
  rule: BotRule;
  busy: boolean;
  onBehavior(behavior: BotRuleBehavior): void;
  onEdit(): void;
  onDelete(): void;
}) {
  const title = ruleTitle(bot, rule);
  const custom = rule.actionClass === undefined;
  return (
    <div className={ROW_CLASS}>
      <span className="min-w-0 flex-1">
        <span className="block text-regular text-primary">{title}</span>
        <span className="mt-0.5 block text-small text-secondary">{botRuleBehaviorLabel(rule.behavior)}</span>
      </span>
      {rule.locked ? (
        <span className="flex shrink-0 items-center gap-1.5 text-small text-secondary">
          <LockKeyhole aria-hidden="true" className="size-3.5" />
          Always
        </span>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button iconOnly variant="transparent" size="small" aria-label={`Change rule: ${title}`} disabled={busy}>
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup
              value={rule.behavior}
              onValueChange={(value) => {
                if (isBotRuleBehavior(value) && value !== rule.behavior) onBehavior(value);
              }}
            >
              {BEHAVIORS.map((behavior) => (
                <DropdownMenuRadioItem key={behavior} value={behavior}>
                  {botRuleBehaviorLabel(behavior)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            {custom ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onEdit}>Edit…</DropdownMenuItem>
                <DropdownMenuItem color="status-red" onSelect={onDelete}>
                  Delete
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function BotRuleEditor({
  bot,
  rule,
  open,
  busy,
  onOpenChange,
  onSave,
}: {
  bot: RuleBot;
  /** The custom rule being edited; a new rule when absent. */
  rule?: BotRule;
  open: boolean;
  busy: boolean;
  onOpenChange(open: boolean): void;
  onSave(
    change: { type: "add_custom"; text: string; behavior: BotRuleBehavior } | { type: "edit_custom"; ruleId: string; text: string; behavior: BotRuleBehavior },
  ): Promise<BotRuleChangeOutcome>;
}) {
  const formId = React.useId();
  const [text, setText] = React.useState(rule?.text ?? "");
  const [behavior, setBehavior] = React.useState<BotRuleBehavior>(rule?.behavior ?? "ask");
  const [error, setError] = React.useState<string | null>(null);

  const save = async () => {
    if (busy) return;
    if (!text.trim()) return setError(`Say what ${bot.name} might do, like “book a flight”.`);
    setError(null);
    const outcome = await onSave(
      rule ? { type: "edit_custom", ruleId: rule.id, text, behavior } : { type: "add_custom", text, behavior },
    );
    if (outcome === null) onOpenChange(false);
    else setError(outcome);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={rule ? "Edit rule" : "Add a rule"}
      description={`Aiden checks every action ${bot.name} takes against your rules.`}
      confirmLabel="Save"
      confirmDisabled={busy}
      busy={busy}
      onConfirm={save}
      submitOnEnter
    >
      <div className="space-y-4">
        {error ? (
          <Callout color="red" role="alert">
            <Text variant="small-strong" color="red">
              {error}
            </Text>
          </Callout>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor={`${formId}-text`} className="text-small-strong">
            When {bot.name} wants to
          </FieldLabel>
          <Input
            id={`${formId}-text`}
            value={text}
            maxLength={BOT_RULE_TEXT_MAX_CHARS}
            placeholder="book a flight"
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
          />
        </div>
        <RadioGroup
          orientation="vertical"
          aria-label="What it does"
          value={behavior}
          onValueChange={(value) => {
            if (isBotRuleBehavior(value)) setBehavior(value);
          }}
          className="gap-1.5"
        >
          {BEHAVIORS.map((option) => (
            <Label
              key={option}
              className="cursor-pointer items-start rounded-control bg-well px-3 py-2.5 transition-colors duration-150 hover:bg-list-hover has-[[data-state=checked]]:bg-list-selection motion-reduce:transition-none"
            >
              <RadioGroupItem
                value={option}
                disabled={busy}
                className="mt-0.5 shrink-0 focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover"
              />
              <span className="min-w-0">
                <span className="block text-regular text-primary">{botRuleBehaviorLabel(option)}</span>
                <span className="mt-0.5 block text-small text-secondary">{behaviorDescription(bot, option)}</span>
              </span>
            </Label>
          ))}
        </RadioGroup>
      </div>
    </Dialog>
  );
}
