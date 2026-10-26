// Settings → Web Search → Web pages: whether the agent may read public pages
// (`web_fetch`), and extract mode with its extraction model's setup.
//
// The Cloudflare key lives in the main-owned key pool; this view only adds
// keys through the write-only pool editor and never sees one.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { Badge, Button, Field, FieldSet, Input, Switch, Text } from "../ui";
import { webFetchApi } from "../../lib/ipc";
import { queryKeys, useWebFetch } from "../../lib/queries";
import {
  WEB_EXTRACT_MODELS,
  normalizeWebExtractAccountId,
  type WebFetchRendererSnapshot,
} from "../../shared/web-fetch-settings";
import { WebSearchKeyPoolEditor } from "./web-search-key-pool";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** What the extract row says about its setup; exported for rendering tests. */
export function webExtractStatus(snapshot: WebFetchRendererSnapshot): {
  label: string;
  color?: "green" | "warning";
} {
  if (snapshot.extract.active) return { label: "On", color: "green" };
  if (!snapshot.extract.ready) return { label: "Needs setup", color: "warning" };
  return { label: "Off" };
}

export function WebPageSettingsView({
  snapshot,
  busy,
  error,
  notice,
  onSetEnabled,
  onSetExtractEnabled,
  onSaveAccountId,
  onKeysChanged,
}: {
  snapshot: WebFetchRendererSnapshot;
  busy: boolean;
  error: string | null;
  notice: string | null;
  onSetEnabled: (enabled: boolean) => void;
  onSetExtractEnabled: (enabled: boolean) => void;
  onSaveAccountId: (accountId: string | null) => Promise<boolean>;
  onKeysChanged: () => void;
}) {
  const model = WEB_EXTRACT_MODELS[snapshot.settings.extract.model];
  const savedAccountId = snapshot.settings.extract.accountId ?? "";
  const [accountDraft, setAccountDraft] = React.useState(savedAccountId);
  React.useEffect(() => setAccountDraft(savedAccountId), [savedAccountId]);
  const draftValid = accountDraft.trim() === "" || normalizeWebExtractAccountId(accountDraft) !== undefined;
  const draftChanged = (normalizeWebExtractAccountId(accountDraft) ?? accountDraft.trim()) !== savedAccountId;
  const status = webExtractStatus(snapshot);
  const reading = snapshot.settings.enabled;

  return (
    <FieldSet title="Web pages">
      <Field
        label="Read web pages"
        description={
          snapshot.webSearchEnabled
            ? "Lets the agent open a public page and read its text in your chats. Pages on this computer or your local network are never opened."
            : "Turn on Web Search above to let the agent read pages."
        }
      >
        <Switch
          checked={reading}
          onCheckedChange={onSetEnabled}
          disabled={busy}
          aria-label="Read web pages"
        />
      </Field>

      {reading ? (
        <>
          <Field
            label={
              <span className="inline-flex flex-wrap items-center gap-2">
                Extract only the values asked for
                <Badge color={status.color}>{status.label}</Badge>
              </span>
            }
            description={
              snapshot.extract.ready
                ? "When the agent needs a few facts, such as a price or a date, it gets just those values, each with the line of the page it came from. Values that are not on the page come back as guesses."
                : `Add your ${model.accountIdLabel} and an API key below to turn this on.`
            }
          >
            <Switch
              checked={snapshot.settings.extract.enabled && snapshot.extract.ready}
              onCheckedChange={onSetExtractEnabled}
              disabled={busy || (!snapshot.extract.ready && !snapshot.settings.extract.enabled)}
              aria-label="Extract only the values asked for"
            />
          </Field>

          <Field
            label={model.accountIdLabel}
            description={
              <>
                Extract mode runs {model.label} on your own Cloudflare account. The account ID is
                the 32-character ID on your Cloudflare dashboard.{" "}
                <a
                  href={model.keyHelpUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-secondary underline decoration-primary/20 underline-offset-2 hover:text-primary"
                >
                  How to get an ID and a key <ExternalLink aria-hidden="true" className="size-3.5" />
                </a>
              </>
            }
            orientation="vertical"
          >
            <form
              className="grid gap-2 min-[540px]:grid-cols-[minmax(0,1fr)_auto]"
              onSubmit={(event) => {
                event.preventDefault();
                if (!draftValid || !draftChanged) return;
                void onSaveAccountId(accountDraft.trim() ? accountDraft.trim() : null);
              }}
            >
              <Input
                value={accountDraft}
                onChange={(event) => setAccountDraft(event.target.value)}
                placeholder="0123456789abcdef0123456789abcdef"
                autoComplete="off"
                spellCheck={false}
                maxLength={64}
                aria-label={model.accountIdLabel}
                aria-invalid={!draftValid || undefined}
                disabled={busy}
                className="h-10 w-full font-mono"
              />
              <Button
                type="submit"
                variant="accent"
                size="small"
                className="h-10"
                disabled={busy || !draftValid || !draftChanged}
              >
                {accountDraft.trim() || !savedAccountId ? "Save" : "Remove"}
              </Button>
            </form>
            {!draftValid ? (
              <Text as="p" variant="small" color="red">
                An account ID is 32 letters and digits (0–9, a–f).
              </Text>
            ) : null}
          </Field>

          <div className="relative after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-separator">
            <WebSearchKeyPoolEditor
              providerId={model.credentialId}
              providerLabel={model.vendor}
              use="extraction"
              onChanged={onKeysChanged}
            />
          </div>

          <Field
            label="What leaves this device"
            description={`In extract mode the page's text and the field names go to ${model.vendor}; your chat does not. Keys stay encrypted on this device and are never passed to the model.`}
            orientation="vertical"
          />
        </>
      ) : null}

      {notice ? (
        <Text as="p" variant="small" color="secondary" role="status" className="px-4 pb-4">
          {notice}
        </Text>
      ) : null}
      {error ? (
        <Text as="p" variant="small" color="red" role="alert" className="px-4 pb-4">
          {error}
        </Text>
      ) : null}
    </FieldSet>
  );
}

/** Stateful group shown on the Web Search page. */
export function WebPageSettings() {
  const queryClient = useQueryClient();
  const query = useWebFetch();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const snapshot = query.data;

  const apply = React.useCallback(
    (next: WebFetchRendererSnapshot) => queryClient.setQueryData(queryKeys.webFetch, next),
    [queryClient],
  );

  const run = React.useCallback(
    async (
      action: () => Promise<WebFetchRendererSnapshot>,
      options: { optimistic?: WebFetchRendererSnapshot; success?: string; failure: string },
    ): Promise<boolean> => {
      const previous = queryClient.getQueryData<WebFetchRendererSnapshot>(queryKeys.webFetch);
      // Switches move at once and settle when main answers.
      if (options.optimistic) apply(options.optimistic);
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        apply(await action());
        if (options.success) setNotice(options.success);
        return true;
      } catch (caught) {
        if (options.optimistic && previous) apply(previous);
        setError(errorMessage(caught, options.failure));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [apply, queryClient],
  );

  if (!snapshot) return null;

  return (
    <WebPageSettingsView
      snapshot={snapshot}
      busy={busy}
      error={error}
      notice={notice}
      onSetEnabled={(enabled) =>
        void run(() => webFetchApi.setEnabled(enabled), {
          optimistic: { ...snapshot, settings: { ...snapshot.settings, enabled } },
          failure: "Couldn’t change page reading.",
        })
      }
      onSetExtractEnabled={(enabled) =>
        void run(() => webFetchApi.setExtractEnabled(enabled), {
          optimistic: {
            ...snapshot,
            settings: { ...snapshot.settings, extract: { ...snapshot.settings.extract, enabled } },
            extract: { ...snapshot.extract, active: enabled && snapshot.extract.ready },
          },
          failure: "Couldn’t change extract mode.",
        })
      }
      onSaveAccountId={(accountId) =>
        run(() => webFetchApi.setExtractAccountId(accountId), {
          success: accountId ? "Account ID saved." : "Account ID removed.",
          failure: "Couldn’t save the account ID.",
        })
      }
      onKeysChanged={() => {
        webFetchApi
          .get()
          .then(apply)
          .catch(() => undefined);
      }}
    />
  );
}
