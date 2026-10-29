import * as React from "react";
import { RefreshCw } from "lucide-react";
import { Button, Field, FieldSet, Text, toast } from "../../components/ui";
import { botsApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import { BOT_HEALTH_LABELS, botHealthStatus, type BotHealthCheckResult, type BotHealthReport, type BotHealthStatus } from "../../shared/bot-health";
import { useBotLiveSummary } from "./bot-sidebar-rows";
import type { BotDefinition } from "../../shared/bots";

const RESULT_WORDS: Record<BotHealthCheckResult["status"], string> = {
  ok: "Working",
  repaired: "Fixed",
  needs_you: "Needs you",
  skipped: "Not checked",
};

const RESULT_COLOR: Record<BotHealthCheckResult["status"], "secondary" | "tertiary" | "status-red"> = {
  ok: "secondary",
  repaired: "secondary",
  needs_you: "status-red",
  skipped: "tertiary",
};

function checkedWhen(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * The checks behind a Bot's health status, as plain rows: what was checked
 * and whether it works. A check that Aiden fixed on its own reads as fixed,
 * not as a problem.
 */
export function BotHealthGroup({
  report,
  status,
  checking,
  onCheck,
}: {
  report: BotHealthReport | null;
  /** The one status the Bot shows: Ready, Needs you or Paused. */
  status?: BotHealthStatus;
  checking: boolean;
  onCheck(): void;
}) {
  const shown = report?.results.filter((result) => result.status !== "skipped" || result.id !== "computer") ?? [];
  return (
    <FieldSet title="Health">
      {status ? (
        <Field label="Status">
          <Text as="span" variant="small" color={status === "needs_you" ? "status-red" : "secondary"} className="justify-self-end">
            {BOT_HEALTH_LABELS[status]}
          </Text>
        </Field>
      ) : null}
      {shown.length ? (
        shown.map((result) => (
          <Field key={result.id} label={result.label}>
            <Text as="span" variant="small" color={RESULT_COLOR[result.status]} className="justify-self-end">
              {RESULT_WORDS[result.status]}
            </Text>
          </Field>
        ))
      ) : (
        <Field label="Not checked yet" description="Aiden checks a Bot before each routine runs." />
      )}
      <Field
        label="Check now"
        {...(report ? { description: `Last checked at ${checkedWhen(report.checkedAt)}.` } : {})}
      >
        <Button size="small" variant="filled" className="justify-self-end" disabled={checking} onClick={onCheck}>
          <RefreshCw /> {checking ? "Checking…" : "Check now"}
        </Button>
      </Field>
    </FieldSet>
  );
}

/** Profile → Health for one Bot. */
export function BotHealthSection({ bot }: { bot: Pick<BotDefinition, "id" | "name"> }) {
  const [report, setReport] = React.useState<BotHealthReport | null>(null);
  const [checking, setChecking] = React.useState(false);
  React.useEffect(() => {
    let live = true;
    void botsApi.health.report(bot.id).then((next) => {
      if (live) setReport(next);
    }).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [bot.id]);
  const check = async () => {
    setChecking(true);
    try {
      setReport(await botsApi.health.check(bot.id));
    } catch (error) {
      toast.error(userFacingErrorMessage(error, `Aiden couldn’t check ${bot.name}.`));
    } finally {
      setChecking(false);
    }
  };
  const summary = useBotLiveSummary(bot.id).data;
  const status = summary
    ? botHealthStatus({
        paused: summary.state.kind === "paused",
        sessionState: summary.state.kind,
        openIssues: summary.needsYou ? 1 : 0,
        ...(report ? { report } : {}),
      })
    : undefined;
  return <BotHealthGroup report={report} {...(status ? { status } : {})} checking={checking} onCheck={() => void check()} />;
}
