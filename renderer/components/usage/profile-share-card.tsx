import * as React from "react";
import {
  buildProfileShareData,
  compactUsageNumber,
  PROFILE_SHARE_HEIGHT,
  PROFILE_SHARE_WIDTH,
} from "../../lib/profile-share-data";
import type { UsageSummary } from "../../lib/types";

interface SharePalette {
  background: string;
  panel: string;
  panelSecondary: string;
  text: string;
  secondary: string;
  tertiary: string;
  track: string;
  separator: string;
  accent: string;
}

function palette(dark: boolean, accent: string): SharePalette {
  return dark
    ? {
        background: "#171719",
        panel: "#202023",
        panelSecondary: "#1D1D20",
        text: "#F7F7F8",
        secondary: "#B2B2B8",
        tertiary: "#9999A0",
        track: "#343439",
        separator: "#38383D",
        accent,
      }
    : {
        background: "#F3F4F5",
        panel: "#FFFFFF",
        panelSecondary: "#FAFAFB",
        text: "#171719",
        secondary: "#66666B",
        tertiary: "#6F6F75",
        track: "#E4E5E7",
        separator: "#DDDEE1",
        accent,
      };
}

function truncate(value: string, maximum: number): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/giu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const characters = [...normalized];
  return characters.length <= maximum
    ? normalized
    : `${characters.slice(0, maximum - 1).join("")}…`;
}

const FONT_FAMILY =
  "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif";

export const ProfileShareCard = React.forwardRef<
  SVGSVGElement,
  { name: string; summary: UsageSummary; dark: boolean; accent: string }
>(function ProfileShareCard({ name, summary, dark, accent }, ref) {
  const data = React.useMemo(() => buildProfileShareData(name, summary), [name, summary]);
  const displayName = truncate(data.name, 24);
  const colors = palette(dark, accent);
  const tokenTotal = data.tokenMix.reduce((total, item) => total + item.value, 0);
  const maximumModelRequests = Math.max(0, ...data.topModels.map((model) => model.requests));
  const cellPitch = 17;
  const cellSize = 12;
  const gridWidth =
    data.calendar.weekCount * cellSize +
    Math.max(0, data.calendar.weekCount - 1) * (cellPitch - cellSize);
  const gridX = 630 - gridWidth / 2;
  const gridY = 740;
  const visibleMonths = data.calendar.months.reduce<typeof data.calendar.months>(
    (months, month) => {
      const previous = months[months.length - 1];
      if (!previous || month.weekIndex - previous.weekIndex >= 3) months.push(month);
      return months;
    },
    [],
  );
  let tokenOffset = 0;

  return (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={PROFILE_SHARE_WIDTH}
      height={PROFILE_SHARE_HEIGHT}
      viewBox={`0 0 ${PROFILE_SHARE_WIDTH} ${PROFILE_SHARE_HEIGHT}`}
      role="img"
      aria-labelledby="profile-share-card-title profile-share-card-description"
      className="block h-auto w-full rounded-dialog shadow-popover"
      style={{ fontFamily: FONT_FAMILY }}
    >
      <title id="profile-share-card-title">{`${displayName}'s Aiden model usage profile`}</title>
      <desc id="profile-share-card-description">
        A private summary with reported tokens, requests, streaks, model activity, token mix, and
        top models.
      </desc>
      <defs>
        <clipPath id="profile-share-name-clip">
          <rect x="72" y="105" width="1056" height="64" />
        </clipPath>
        <clipPath id="profile-share-model-clip">
          <rect x="686" y="0" width="322" height="1600" />
        </clipPath>
      </defs>
      <rect width={PROFILE_SHARE_WIDTH} height={PROFILE_SHARE_HEIGHT} fill={colors.background} />

      <text
        x="72"
        y="84"
        fill={colors.secondary}
        fontSize="23"
        fontWeight="600"
        letterSpacing="2.8"
      >
        AIDEN AGENT · MODEL USAGE
      </text>
      <text x="1128" y="84" fill={colors.secondary} fontSize="23" textAnchor="end">
        {data.rangeLabel}
      </text>
      <text
        x="72"
        y="154"
        fill={colors.text}
        fontSize="48"
        fontWeight="650"
        clipPath="url(#profile-share-name-clip)"
      >
        {displayName}
      </text>
      <text
        x="72"
        y="230"
        fill={colors.secondary}
        fontSize="21"
        fontWeight="600"
        letterSpacing="1.6"
      >
        REPORTED TOKENS
      </text>
      <text x="72" y="334" fill={colors.text} fontSize="104" fontWeight="650" letterSpacing="-3">
        {data.reportedTokens}
      </text>
      <text x="1128" y="322" fill={colors.secondary} fontSize="22" textAnchor="end">
        {data.tokenCoverage} token coverage
      </text>
      <text x="1128" y="354" fill={colors.tertiary} fontSize="18" textAnchor="end">
        Local and unmetered calls still count as activity
      </text>

      <rect x="72" y="400" width="1056" height="145" rx="28" fill={colors.panel} />
      {[336, 600, 864].map((x) => (
        <line key={x} x1={x} x2={x} y1="430" y2="515" stroke={colors.separator} />
      ))}
      {[
        ["REQUESTS", data.requests],
        ["ACTIVE DAYS", data.activeDays],
        ["CURRENT STREAK", data.currentStreak],
        ["BEST STREAK", data.longestStreak],
      ].map(([label, value], index) => (
        <g key={label} transform={`translate(${104 + index * 264} 0)`}>
          <text y="450" fill={colors.secondary} fontSize="18" fontWeight="600" letterSpacing="1.2">
            {label}
          </text>
          <text y="500" fill={colors.text} fontSize="38" fontWeight="620">
            {value}
          </text>
        </g>
      ))}

      <rect x="72" y="575" width="1056" height="400" rx="28" fill={colors.panel} />
      <text x="104" y="630" fill={colors.text} fontSize="27" fontWeight="620">
        Model activity
      </text>
      <text x="104" y="665" fill={colors.secondary} fontSize="19">
        {data.activityRangeLabel} · {data.activityActiveDays} active{" "}
        {data.activityActiveDays === "1" ? "day" : "days"}
      </text>

      {visibleMonths.map((month) => (
        <text
          key={`${month.weekIndex}-${month.label}`}
          x={gridX + month.weekIndex * cellPitch}
          y="718"
          fill={colors.tertiary}
          fontSize="16"
        >
          {month.label}
        </text>
      ))}
      {["Mon", "Wed", "Fri"].map((label, index) => (
        <text
          key={label}
          x={gridX - 18}
          y={gridY + (index * 2 + 1) * cellPitch + 10}
          fill={colors.tertiary}
          fontSize="15"
          textAnchor="end"
        >
          {label}
        </text>
      ))}
      {data.calendar.cells.map((cell, index) => {
        if (!cell.inRange) return null;
        const week = Math.floor(index / 7);
        const weekday = index % 7;
        return (
          <rect
            key={cell.date}
            x={gridX + week * cellPitch}
            y={gridY + weekday * cellPitch}
            width={cellSize}
            height={cellSize}
            rx="2.5"
            fill={cell.level === 0 ? colors.track : colors.accent}
            fillOpacity={cell.level === 0 ? 1 : [0, 0.24, 0.42, 0.68, 1][cell.level]}
          />
        );
      })}
      <g transform="translate(865 918)">
        <text x="0" y="10" fill={colors.tertiary} fontSize="15">
          Less
        </text>
        {[0, 1, 2, 3, 4].map((level) => (
          <rect
            key={level}
            x={42 + level * 22}
            y="0"
            width="12"
            height="12"
            rx="2.5"
            fill={level === 0 ? colors.track : colors.accent}
            fillOpacity={level === 0 ? 1 : [0, 0.24, 0.42, 0.68, 1][level]}
          />
        ))}
        <text x="158" y="10" fill={colors.tertiary} fontSize="15">
          More
        </text>
      </g>

      <rect x="72" y="1005" width="510" height="490" rx="28" fill={colors.panelSecondary} />
      <text x="104" y="1062" fill={colors.text} fontSize="27" fontWeight="620">
        Token mix
      </text>
      <text x="550" y="1062" fill={colors.secondary} fontSize="19" textAnchor="end">
        {data.reportedTokens} total
      </text>
      <rect x="104" y="1100" width="446" height="14" rx="7" fill={colors.track} />
      {tokenTotal > 0
        ? data.tokenMix.map((item, index) => {
            const width = (item.value / tokenTotal) * 446;
            const element = (
              <rect
                key={item.key}
                x={104 + tokenOffset}
                y="1100"
                width={width}
                height="14"
                fill={colors.accent}
                fillOpacity={[1, 0.72, 0.48, 0.28][index]}
              />
            );
            tokenOffset += width;
            return element;
          })
        : null}
      {data.tokenMix.map((item, index) => {
        const percentage = tokenTotal > 0 ? (item.value / tokenTotal) * 100 : 0;
        const y = 1170 + index * 72;
        return (
          <g key={item.key}>
            <circle
              cx="112"
              cy={y - 6}
              r="6"
              fill={colors.accent}
              fillOpacity={[1, 0.72, 0.48, 0.28][index]}
            />
            <text x="132" y={y} fill={colors.text} fontSize="20">
              {item.label}
            </text>
            <text x="550" y={y} fill={colors.secondary} fontSize="18" textAnchor="end">
              {compactUsageNumber(item.value)} · {percentage.toFixed(1)}%
            </text>
            <rect x="132" y={y + 18} width="418" height="7" rx="3.5" fill={colors.track} />
            <rect
              x="132"
              y={y + 18}
              width={(percentage / 100) * 418}
              height="7"
              rx="3.5"
              fill={colors.accent}
              fillOpacity={[1, 0.72, 0.48, 0.28][index]}
            />
          </g>
        );
      })}

      <rect x="618" y="1005" width="510" height="490" rx="28" fill={colors.panelSecondary} />
      <text x="650" y="1062" fill={colors.text} fontSize="27" fontWeight="620">
        Top models
      </text>
      <text x="1096" y="1062" fill={colors.secondary} fontSize="19" textAnchor="end">
        By requests
      </text>
      {data.topModels.length === 0 ? (
        <text x="650" y="1140" fill={colors.secondary} fontSize="20">
          No model calls yet
        </text>
      ) : (
        data.topModels.map((model, index) => {
          const y = 1135 + index * 70;
          const width =
            maximumModelRequests > 0 ? (model.requests / maximumModelRequests) * 410 : 0;
          return (
            <g key={`${model.providerId}-${model.modelId}`}>
              <text x="650" y={y} fill={colors.tertiary} fontSize="19">
                {index + 1}
              </text>
              <text
                x="686"
                y={y}
                fill={colors.text}
                fontSize="20"
                fontWeight="560"
                clipPath="url(#profile-share-model-clip)"
              >
                {truncate(model.modelLabel, 20)}
              </text>
              <text x="1096" y={y} fill={colors.secondary} fontSize="18" textAnchor="end">
                {compactUsageNumber(model.requests)}
              </text>
              <rect x="686" y={y + 18} width="410" height="7" rx="3.5" fill={colors.track} />
              <rect
                x="686"
                y={y + 18}
                width={Math.min(410, width)}
                height="7"
                rx="3.5"
                fill={colors.accent}
                fillOpacity="0.74"
              />
              <text x="686" y={y + 48} fill={colors.tertiary} fontSize="15">
                {truncate(model.providerLabel, 28)}
                {model.local ? " · Local" : ""}
              </text>
            </g>
          );
        })
      )}

      <text x="72" y="1554" fill={colors.tertiary} fontSize="18">
        PRIVATE · GENERATED ON THIS MAC · NO PROMPTS OR CHAT CONTENT
      </text>
      <circle cx="1108" cy="1548" r="7" fill={colors.accent} />
      <text x="1090" y="1554" fill={colors.secondary} fontSize="18" textAnchor="end">
        Aiden
      </text>
    </svg>
  );
});
