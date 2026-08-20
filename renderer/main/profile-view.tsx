import * as React from "react";
import { Check, Laptop, Pencil, RotateCcw, Share2, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Dialog,
  EmptyState,
  Input,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Text,
  toast,
} from "../components/ui";
import { ActivityHeatmap } from "../components/usage/activity-heatmap";
import { ModelScoreboard } from "../components/usage/model-scoreboard";
import { ProfileShareCard } from "../components/usage/profile-share-card";
import { TokenMix } from "../components/usage/token-mix";
import { profileApi } from "../lib/ipc";
import { profileShareSvgToPng, USAGE_RANGE_LABELS } from "../lib/profile-share-data";
import { formatTrackedUsd, profileInitials } from "../lib/usage-profile-data";
import { queryKeys, useProfile, useProviders, useUsageSummary } from "../lib/queries";
import type { UsageDateRange, UsageSummary } from "../lib/types";

function compactNumber(value: number): string {
  return Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function ProfileIdentity() {
  const profile = useProfile();
  const queryClient = useQueryClient();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (profile.data?.name && !editing) setDraft(profile.data.name);
  }, [editing, profile.data?.name]);

  const cancelEditing = () => {
    setDraft(profile.data?.name ?? "");
    setEditing(false);
  };

  const saveName = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const saved = await profileApi.setName(draft);
      queryClient.setQueryData(queryKeys.profile, saved);
      setDraft(saved.name);
      setEditing(false);
      toast.success("Profile name updated.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't update your profile name.");
    } finally {
      setSaving(false);
    }
  };

  if (profile.isError) {
    return (
      <div className="flex min-h-20 items-center justify-between gap-4 py-5">
        <div>
          <Text as="p" variant="strong">
            Profile unavailable
          </Text>
          <Text as="p" variant="small" color="secondary" className="mt-0.5">
            Your usage is still stored privately on this Mac.
          </Text>
        </div>
        <Button variant="transparent" size="small" onClick={() => void profile.refetch()}>
          <RotateCcw /> Retry
        </Button>
      </div>
    );
  }

  const name = profile.data?.name ?? "Loading profile…";

  return (
    <section aria-label="Local profile" className="flex min-h-24 items-center gap-4 py-5">
      <div
        aria-hidden="true"
        className="grid size-13 shrink-0 place-items-center rounded-full bg-accent/12 text-[16px] font-semibold text-accent"
      >
        {profile.data ? profileInitials(profile.data.name) : ""}
      </div>
      <div className="min-w-0 flex-1">
        {editing ? (
          <form
            className="flex min-w-0 max-w-md items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              void saveName();
            }}
          >
            <Input
              autoFocus
              aria-label="Profile name"
              className="min-w-0 flex-1"
              maxLength={80}
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelEditing();
                }
              }}
            />
            <Button
              iconOnly
              size="medium"
              variant="transparent"
              aria-label="Save profile name"
              disabled={saving || !draft.trim()}
              type="submit"
            >
              <Check />
            </Button>
            <Button
              iconOnly
              size="medium"
              variant="transparent"
              aria-label="Cancel editing profile name"
              disabled={saving}
              onClick={cancelEditing}
            >
              <X />
            </Button>
          </form>
        ) : (
          <div className="flex min-w-0 items-center gap-1.5">
            <Text as="h2" variant="heading1" truncate>
              {name}
            </Text>
            {profile.data ? (
              <Button
                iconOnly
                size="small"
                variant="transparent"
                aria-label="Edit profile name"
                onClick={() => setEditing(true)}
              >
                <Pencil className="size-3.5" />
              </Button>
            ) : null}
          </div>
        )}
        <Text as="p" variant="small" color="secondary" className="mt-1 flex items-center gap-1.5">
          <Laptop aria-hidden="true" className="size-3.5" /> Only on this Mac
        </Text>
      </div>
    </section>
  );
}

function SummaryMetric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="usage-profile-stat min-w-0 px-5 py-1 first:pl-0 last:pr-0">
      <Text
        as="p"
        variant="small-strong"
        color="secondary"
        className="uppercase tracking-[0.045em]"
      >
        {label}
      </Text>
      <Text as="p" className="mt-1 text-[22px] font-semibold leading-7 tabular-nums">
        {value}
      </Text>
      {detail ? (
        <Text as="p" variant="small" color="tertiary" className="mt-0.5">
          {detail}
        </Text>
      ) : null}
    </div>
  );
}

function UsageContent({ summary }: { summary: UsageSummary }) {
  const providers = useProviders();
  const totals = summary.totals;
  const coverage = totals.requests > 0 ? (totals.reportedTokenRequests / totals.requests) * 100 : 0;

  return (
    <>
      <ActivityHeatmap summary={summary} />
      <Separator />

      <section aria-label="Usage summary" className="usage-profile-stats grid grid-cols-4 py-6">
        <SummaryMetric
          label="Reported tokens"
          value={compactNumber(totals.tokens.total)}
          detail={
            totals.unmeteredRequests > 0
              ? `${compactNumber(totals.unmeteredRequests)} unmetered requests`
              : undefined
          }
        />
        <SummaryMetric label="Requests" value={compactNumber(totals.requests)} />
        <SummaryMetric
          label="Current streak"
          value={`${totals.currentStreak}`}
          detail={totals.currentStreak === 1 ? "day" : "days"}
        />
        <SummaryMetric
          label="Active days"
          value={compactNumber(totals.activeDays)}
          detail={`Best streak ${totals.longestStreak} ${totals.longestStreak === 1 ? "day" : "days"}`}
        />
      </section>

      <Separator />
      <div className="usage-profile-lower grid grid-cols-2 gap-0">
        <TokenMix tokens={totals.tokens} />
        <ModelScoreboard models={summary.models} providers={providers.data} />
      </div>
      <Separator />

      <footer className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-5">
        <Text variant="small" color="secondary">
          {totals.requests === 0
            ? "Tracking begins with your next model call."
            : `${coverage.toFixed(0)}% of requests reported token usage.`}
        </Text>
        <Text variant="small" color="tertiary" className="text-right tabular-nums">
          {totals.costedRequests > 0
            ? `Tracked hosted cost ${formatTrackedUsd(totals.hostedCostUsd)}`
            : "No tracked hosted cost"}
          {totals.unpricedHostedRequests > 0
            ? ` · Cost unavailable for ${totals.unpricedHostedRequests.toLocaleString()} hosted requests`
            : ""}
          {totals.localRequests > 0
            ? ` · ${totals.localRequests.toLocaleString()} local excluded from cost`
            : ""}
        </Text>
      </footer>
    </>
  );
}

export function ProfileView() {
  const [range, setRange] = React.useState<UsageDateRange>("1y");
  const [shareOpen, setShareOpen] = React.useState(false);
  const [sharing, setSharing] = React.useState(false);
  const [shareDark, setShareDark] = React.useState(false);
  const [shareAccent, setShareAccent] = React.useState("#138af2");
  const shareCardRef = React.useRef<SVGSVGElement>(null);
  const usage = useUsageSummary(range);
  const profile = useProfile();

  const openSharePreview = () => {
    const root = document.documentElement;
    setShareDark(root.classList.contains("dark"));
    setShareAccent(getComputedStyle(root).getPropertyValue("--accent").trim() || "#138af2");
    setShareOpen(true);
  };

  const shareProfile = async () => {
    if (!shareCardRef.current || !usage.data || !profile.data || sharing) return;
    setSharing(true);
    try {
      const image = await profileShareSvgToPng(shareCardRef.current);
      await profileApi.shareImage(image);
      setShareOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't share the profile snapshot.");
    } finally {
      setSharing(false);
    }
  };

  return (
    <>
      <ScrollArea
        title="Profile"
        actions={
          <>
            <Button
              variant="transparent"
              size="small"
              disabled={!usage.data || !profile.data}
              aria-label="Share profile snapshot"
              title="Share profile snapshot"
              onClick={openSharePreview}
            >
              <Share2 /> <span className="profile-share-label">Share</span>
            </Button>
            <Select value={range} onValueChange={(value) => setRange(value as UsageDateRange)}>
              <SelectTrigger
                size="small"
                aria-label="Usage date range"
                className="w-[112px] whitespace-nowrap"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {(Object.entries(USAGE_RANGE_LABELS) as [UsageDateRange, string][]).map(
                  ([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </>
        }
      >
        <div className="usage-profile-content mx-auto w-full max-w-[980px] px-6 pb-8">
          <ProfileIdentity />
          <Separator />
          {usage.isLoading ? (
            <div role="status" aria-label="Loading usage profile" className="space-y-5 py-8">
              <div className="h-4 w-32 animate-pulse rounded bg-control" />
              <div className="h-28 w-full animate-pulse rounded-card bg-well" />
              <div className="grid grid-cols-4 gap-5">
                {Array.from({ length: 4 }, (_, index) => (
                  <div key={index} className="h-16 animate-pulse rounded-card bg-well" />
                ))}
              </div>
              <span className="sr-only">Loading usage…</span>
            </div>
          ) : usage.isError || !usage.data ? (
            <div role="alert" className="flex min-h-72 flex-col items-center justify-center">
              <EmptyState
                placement="inline"
                title="Usage profile unavailable"
                description="Your local history is safe. Try loading it again."
                className="py-0"
              />
              <Button className="mt-4" variant="filled" onClick={() => void usage.refetch()}>
                <RotateCcw /> Try again
              </Button>
            </div>
          ) : (
            <UsageContent summary={usage.data} />
          )}
        </div>
      </ScrollArea>

      <Dialog
        open={shareOpen}
        onOpenChange={(open) => {
          if (!sharing) setShareOpen(open);
        }}
        title="Share profile"
        description="Preview and share a PNG containing your name and aggregate model usage."
        size="large"
        confirmLabel={sharing ? "Preparing…" : "Share…"}
        confirmDisabled={sharing || !usage.data || !profile.data}
        cancelDisabled={sharing}
        busy={sharing}
        onConfirm={shareProfile}
      >
        {usage.data && profile.data ? (
          <div>
            <div className="mx-auto w-full max-w-[340px]">
              <ProfileShareCard
                ref={shareCardRef}
                name={profile.data.name}
                summary={usage.data}
                dark={shareDark}
                accent={shareAccent}
              />
            </div>
            <Text
              as="p"
              variant="small"
              color="secondary"
              className="mx-auto mt-4 max-w-md text-center"
            >
              The 3:4 PNG includes your name and aggregate usage only—never prompts, chats,
              workspaces, or file paths.
            </Text>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}
