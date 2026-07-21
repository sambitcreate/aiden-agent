import {
  buildActivityCalendar,
  buildTokenMix,
  rankUsageModels,
  type ActivityCalendar,
  type TokenMixItem,
} from "./usage-profile-data";
import type { UsageDateRange, UsageModelSummary, UsageSummary } from "./types";

const DAY_MS = 86_400_000;

export const PROFILE_SHARE_WIDTH = 1200;
export const PROFILE_SHARE_HEIGHT = 1600;

export const USAGE_RANGE_LABELS: Record<UsageDateRange, string> = {
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
  "1y": "Past year",
  all: "All time",
};

export interface ProfileShareData {
  name: string;
  rangeLabel: string;
  activityRangeLabel: string;
  activityActiveDays: string;
  reportedTokens: string;
  requests: string;
  activeDays: string;
  currentStreak: string;
  longestStreak: string;
  tokenCoverage: string;
  calendar: ActivityCalendar;
  tokenMix: TokenMixItem[];
  topModels: UsageModelSummary[];
}

export function compactUsageNumber(value: number): string {
  return Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function streakLabel(value: number): string {
  return `${compactUsageNumber(value)} ${value === 1 ? "day" : "days"}`;
}

function latestYearCalendar(summary: UsageSummary): {
  calendar: ActivityCalendar;
  clipped: boolean;
} {
  const end = new Date(`${summary.endDate}T00:00:00Z`);
  const latestYearStart = new Date(end.getTime() - 364 * DAY_MS).toISOString().slice(0, 10);
  const startDate = summary.startDate > latestYearStart ? summary.startDate : latestYearStart;
  const clipped = startDate > summary.startDate;
  const calendarSummary: UsageSummary = clipped
    ? {
        ...summary,
        startDate,
        days: summary.days.filter((day) => day.date >= startDate),
      }
    : summary;
  return { calendar: buildActivityCalendar(calendarSummary), clipped };
}

export function buildProfileShareData(name: string, summary: UsageSummary): ProfileShareData {
  const { calendar, clipped } = latestYearCalendar(summary);
  const coverage =
    summary.totals.requests > 0
      ? Math.round((summary.totals.reportedTokenRequests / summary.totals.requests) * 100)
      : 0;
  return {
    name,
    rangeLabel: USAGE_RANGE_LABELS[summary.range],
    activityRangeLabel: clipped
      ? "Latest year activity"
      : `${USAGE_RANGE_LABELS[summary.range]} activity`,
    activityActiveDays: calendar.cells
      .filter((cell) => cell.inRange && cell.requests > 0)
      .length.toLocaleString(),
    reportedTokens: compactUsageNumber(summary.totals.tokens.total),
    requests: compactUsageNumber(summary.totals.requests),
    activeDays: compactUsageNumber(summary.totals.activeDays),
    currentStreak: streakLabel(summary.totals.currentStreak),
    longestStreak: streakLabel(summary.totals.longestStreak),
    tokenCoverage: `${coverage}%`,
    calendar,
    tokenMix: buildTokenMix(summary.totals.tokens),
    topModels: rankUsageModels(summary.models, "requests").slice(0, 5),
  };
}

export async function profileShareSvgToPng(svg: SVGSVGElement): Promise<string> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(PROFILE_SHARE_WIDTH));
  clone.setAttribute("height", String(PROFILE_SHARE_HEIGHT));
  clone.removeAttribute("class");
  const source = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);

  try {
    const image = new Image();
    image.decoding = "sync";
    const loaded = new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error("Aiden timed out while rendering the profile snapshot.")),
        10_000,
      );
      image.onload = () => {
        window.clearTimeout(timeout);
        resolve();
      };
      image.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error("Aiden couldn't render the profile snapshot."));
      };
    });
    image.src = objectUrl;
    await loaded;
    if (image.naturalWidth !== PROFILE_SHARE_WIDTH || image.naturalHeight !== PROFILE_SHARE_HEIGHT) {
      throw new Error("Aiden rendered the profile snapshot at an unexpected size.");
    }

    const canvas = document.createElement("canvas");
    canvas.width = PROFILE_SHARE_WIDTH;
    canvas.height = PROFILE_SHARE_HEIGHT;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Aiden couldn't create the profile snapshot.");
    context.drawImage(image, 0, 0, PROFILE_SHARE_WIDTH, PROFILE_SHARE_HEIGHT);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
