import * as React from "react";
import { formatValue } from "../../shared/aiden-ui/evaluate";
import { subscribeGenerativeUiTheme } from "../../lib/generative-ui-theme-snapshot";
import { asNumber, asRecord, asString } from "./render-context";

/**
 * Native charts for Aiden UI visuals. Chart.js loads lazily, the first time
 * a chart mounts, so it stays out of the main bundle. Colors come from the
 * live `--chart-1…8` series tokens and re-resolve on every theme change.
 * Every chart carries a screen-reader table of its numbers.
 */

type ChartModule = { default: new (canvas: HTMLCanvasElement, config: unknown) => { destroy(): void } };
let loadChartModule: () => Promise<ChartModule> = () => import("chart.js/auto") as unknown as Promise<ChartModule>;

/** Test seam: replace the Chart.js loader. */
export function setChartModuleLoader(loader: () => Promise<ChartModule>): void {
  loadChartModule = loader;
}

export type ValueFormat = "number" | "currency" | "percent" | "date" | "text";

export function formatCell(value: unknown, format: unknown): string {
  if (format === "number" || format === "currency" || format === "percent" || format === "date") {
    return formatValue(value, format, navigator.language || "en-US");
  }
  if (typeof value === "number" && format !== "text") return formatValue(value, "number", navigator.language || "en-US");
  return asString(value);
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** A translucent version of a resolved series color, for area fills. */
function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/iu.exec(color);
  if (hex) return `#${hex[1]}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
  const rgb = /^rgba?\(([^)]+)\)$/iu.exec(color);
  if (rgb) {
    const parts = rgb[1]!.split(/[\s,/]+/u).filter(Boolean).slice(0, 3);
    if (parts.length === 3) return `rgb(${parts.join(" ")} / ${alpha})`;
  }
  return color;
}

function seriesColor(index: number): string {
  return cssVar(`--chart-${(index % 8) + 1}`) || "#1e88c7";
}

function useThemeVersion(): number {
  const [version, setVersion] = React.useState(0);
  React.useEffect(() => subscribeGenerativeUiTheme(() => setVersion((current) => current + 1)), []);
  return version;
}

interface Series {
  key: string;
  label: string;
}

function seriesFor(rows: Record<string, unknown>[], x: string, y: unknown, series: unknown): Series[] {
  if (Array.isArray(series) && series.length) {
    return series
      .map((entry) => (typeof entry === "string" ? { key: entry, label: entry } : { key: asString(asRecord(entry).key), label: asString(asRecord(entry).label) || asString(asRecord(entry).key) }))
      .filter((entry) => entry.key)
      .slice(0, 8);
  }
  if (Array.isArray(y)) return y.filter((key): key is string => typeof key === "string").slice(0, 8).map((key) => ({ key, label: key }));
  if (typeof y === "string" && y) return [{ key: y, label: y }];
  const first = rows[0] ?? {};
  const numeric = Object.keys(first).find((key) => key !== x && typeof first[key] === "number");
  return numeric ? [{ key: numeric, label: numeric }] : [];
}

export interface ChartProps {
  kind: "bar" | "line" | "area" | "pie" | "donut" | "scatter";
  data: unknown;
  x?: string;
  y?: unknown;
  series?: unknown;
  height?: number;
  stacked?: boolean;
  format?: unknown;
  label?: string;
}

export function AidenUiChart({ kind, data, x = "", y, series, height = 220, stacked = false, format, label }: ChartProps) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const themeVersion = useThemeVersion();
  const rows = React.useMemo(() => (Array.isArray(data) ? data.slice(0, 500).map(asRecord) : []), [data]);
  const xKey = x || Object.keys(rows[0] ?? {}).find((key) => typeof rows[0]?.[key] === "string") || "";
  const seriesList = React.useMemo(() => seriesFor(rows, xKey, y, series), [rows, xKey, y, series]);
  const labels = rows.map((row) => asString(row[xKey]));
  const radial = kind === "pie" || kind === "donut";
  const configKey = JSON.stringify([kind, rows, xKey, seriesList, stacked, format]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let chart: { destroy(): void } | null = null;
    let cancelled = false;
    void loadChartModule().then((module) => {
      if (cancelled) return;
      const text = cssVar("--text-secondary");
      const grid = cssVar("--border-separator");
      const font = cssVar("--font-ui-family");
      const datasets = seriesList.map((entry, index) => {
        const values = rows.map((row) => asNumber(row[entry.key], Number.NaN));
        const color = seriesColor(index);
        if (kind === "scatter") {
          return {
            label: entry.label,
            data: rows.map((row) => ({ x: asNumber(row[xKey], Number.NaN), y: asNumber(row[entry.key], Number.NaN) })),
            backgroundColor: color,
          };
        }
        return {
          label: entry.label,
          data: values,
          backgroundColor: radial ? rows.map((_, rowIndex) => seriesColor(rowIndex)) : kind === "area" ? withAlpha(color, 0.2) : color,
          borderColor: radial ? cssVar("--surface-popover") || "#fff" : color,
          borderWidth: radial ? 2 : kind === "bar" ? 0 : 2,
          fill: kind === "area",
          tension: 0.3,
          pointRadius: kind === "line" || kind === "area" ? 2 : undefined,
          borderRadius: kind === "bar" ? 4 : undefined,
        };
      });
      const tick = (value: unknown) => formatCell(value, format);
      chart = new module.default(canvas, {
        type: kind === "donut" ? "doughnut" : kind === "area" ? "line" : kind,
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          color: text,
          font: font ? { family: font } : undefined,
          plugins: {
            legend: { display: radial || seriesList.length > 1, labels: { color: text, boxWidth: 10 } },
            tooltip: { callbacks: { label: (item: { dataset: { label?: string }; parsed: unknown }) => `${item.dataset.label ?? ""}: ${tick(typeof item.parsed === "object" && item.parsed ? (item.parsed as { y?: unknown }).y ?? (item.parsed as { r?: unknown }).r : item.parsed)}` } },
          },
          scales: radial
            ? undefined
            : {
                x: { stacked, ticks: { color: text }, grid: { display: false }, border: { display: false } },
                y: { stacked, ticks: { color: text, callback: tick }, grid: { color: grid }, border: { display: false } },
              },
        },
      });
    });
    return () => {
      cancelled = true;
      chart?.destroy();
    };
    // configKey captures every input the chart is built from.
  }, [configKey, themeVersion]);

  return (
    <figure className="m-0 min-w-0">
      <div className="relative w-full" style={{ height: Math.min(Math.max(height, 120), 600) }}>
        <canvas ref={canvasRef} role="img" aria-label={label || "Chart"} />
      </div>
      <table className="sr-only">
        <caption>{label || "Chart data"}</caption>
        <thead>
          <tr>
            <th scope="col">{xKey}</th>
            {seriesList.map((entry) => (
              <th key={entry.key} scope="col">{entry.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              <th scope="row">{asString(row[xKey])}</th>
              {seriesList.map((entry) => (
                <td key={entry.key}>{formatCell(row[entry.key], format)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

export function AidenUiBarList({ items, labelKey = "label", valueKey = "value", format }: { items: unknown; labelKey?: string; valueKey?: string; format?: unknown }) {
  const rows = Array.isArray(items) ? items.slice(0, 50).map(asRecord) : [];
  const max = Math.max(0, ...rows.map((row) => asNumber(row[valueKey], 0)));
  return (
    <ol className="m-0 flex min-w-0 list-none flex-col gap-1.5 p-0">
      {rows.map((row, index) => {
        const value = asNumber(row[valueKey], 0);
        return (
          <li key={index} className="grid min-w-0 grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] items-center gap-2 text-small">
            <span className="truncate text-secondary">{asString(row[labelKey])}</span>
            <span className="h-2 overflow-hidden rounded-pill bg-control" aria-hidden="true">
              <span
                className="block h-full rounded-pill"
                style={{ width: max > 0 ? `${(value / max) * 100}%` : 0, background: `var(--chart-${(index % 8) + 1})` }}
              />
            </span>
            <span className="tabular-nums text-primary">{formatCell(row[valueKey], format)}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function AidenUiSparkline({ values, height = 32, label }: { values: unknown; height?: number; label?: string }) {
  const numbers = (Array.isArray(values) ? values : []).slice(0, 500).map((value) => asNumber(value, Number.NaN)).filter(Number.isFinite);
  if (numbers.length < 2) return null;
  const min = Math.min(...numbers);
  const span = Math.max(...numbers) - min || 1;
  const points = numbers.map((value, index) => `${(index / (numbers.length - 1)) * 100},${(1 - (value - min) / span) * 100}`).join(" ");
  return (
    <svg
      role="img"
      aria-label={label ? `${label}: ${numbers.join(", ")}` : numbers.join(", ")}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="block w-full max-w-48"
      style={{ height: Math.min(Math.max(height, 16), 120) }}
    >
      <polyline points={points} fill="none" stroke="var(--chart-1)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function AidenUiHeatmap({ rows, x = "x", y = "y", value = "value", label }: { rows: unknown; x?: string; y?: string; value?: string; label?: string }) {
  const cells = Array.isArray(rows) ? rows.slice(0, 2000).map(asRecord) : [];
  const xs = [...new Set(cells.map((cell) => asString(cell[x])))].slice(0, 60);
  const ys = [...new Set(cells.map((cell) => asString(cell[y])))].slice(0, 30);
  const max = Math.max(0, ...cells.map((cell) => asNumber(cell[value], 0)));
  const lookup = new Map(cells.map((cell) => [`${asString(cell[x])}\u0000${asString(cell[y])}`, asNumber(cell[value], 0)]));
  return (
    <div className="min-w-0">
      <div
        role="img"
        aria-label={label || "Heatmap"}
        className="grid gap-[3px]"
        style={{ gridTemplateColumns: `repeat(${Math.max(xs.length, 1)}, minmax(0, 1fr))` }}
      >
        {ys.flatMap((row) =>
          xs.map((column) => {
            const amount = lookup.get(`${column}\u0000${row}`) ?? 0;
            const level = max > 0 ? amount / max : 0;
            return (
              <span
                key={`${row}:${column}`}
                title={`${row} ${column}: ${amount}`}
                className="aspect-square rounded-[2px]"
                style={{ background: level > 0 ? "var(--chart-1)" : "var(--surface-control)", opacity: level > 0 ? 0.2 + level * 0.8 : 1 }}
              />
            );
          }),
        )}
      </div>
      <table className="sr-only">
        <caption>{label || "Heatmap data"}</caption>
        <tbody>
          {cells.map((cell, index) => (
            <tr key={index}>
              <th scope="row">{`${asString(cell[y])} ${asString(cell[x])}`}</th>
              <td>{asString(cell[value])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
