/**
 * The DESIGN.md lint worker: the only module that imports `@google/design.md`.
 *
 * It's built as its own file (`build/main/design-md-lint-worker.js`) and runs
 * in a worker thread, because 0.4.0's `lint` is synchronous and quadratic on
 * some inputs. It posts `{ ready: true }` once the linter has loaded, answers
 * one request, and is terminated by `lint-client.ts`. Only the `/linter` entry
 * point is used: it inlines its dependencies and imports only Node built-ins.
 * It has no network or subprocess code. It returns plain JSON, never `Map`s.
 */
import {
  CssVarsEmitterHandler,
  DtcgEmitterHandler,
  lint,
  serializeCssVars,
  serializeTailwindV4,
  TailwindV4EmitterHandler,
  type DesignSystemState,
  type LintReport,
  type ResolvedValue,
} from "@google/design.md/linter";
import { parentPort } from "node:worker_threads";
import type {
  DesignMdSeverity,
  DesignMdExportResult,
  DesignMdLintResult,
  DesignMdSymbolValue,
  DesignMdWorkerRequest,
} from "./lint-client.js";

function dimensionText(value: unknown): string | undefined {
  if (typeof value === "number") return String(value);
  if (!value || typeof value !== "object") return undefined;
  const { value: amount, unit } = value as { value?: unknown; unit?: unknown };
  return typeof amount === "number" ? `${amount}${typeof unit === "string" ? unit : ""}` : undefined;
}

function symbolValue(value: ResolvedValue): DesignMdSymbolValue {
  if (typeof value === "string") {
    return /^\{[^}]+\}$/.test(value) ? { unresolved: value } : { kind: "value", text: value };
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return { kind: "value", text: String(value) };
  }
  if (value.type === "color") return { kind: "color", text: value.hex };
  if (value.type === "dimension") return { kind: "dimension", text: dimensionText(value) ?? "" };
  const parts: string[] = [];
  if (value.fontFamily !== undefined) parts.push(`fontFamily: ${value.fontFamily}`);
  const size = dimensionText(value.fontSize);
  if (size) parts.push(`fontSize: ${size}`);
  if (value.fontWeight !== undefined) parts.push(`fontWeight: ${value.fontWeight}`);
  const lineHeight = dimensionText(value.lineHeight);
  if (lineHeight) parts.push(`lineHeight: ${lineHeight}`);
  return { kind: "typography", text: parts.join("; ") };
}

function omittedSections(state: DesignSystemState): DesignMdLintResult["omitted"] {
  return (state.omitted ?? []).flatMap((entry: unknown) => {
    if (typeof entry === "string") return [{ section: entry }];
    if (entry && typeof entry === "object" && typeof (entry as { section?: unknown }).section === "string") {
      const { section, reason } = entry as { section: string; reason?: unknown };
      return [typeof reason === "string" ? { section, reason } : { section }];
    }
    return [];
  });
}

function severityOf(value: unknown): DesignMdSeverity {
  return value === "error" || value === "warning" ? value : "info";
}

function lintResult(report: LintReport): DesignMdLintResult {
  return {
    summary: { ...report.summary },
    findings: report.findings.map((finding) => ({
      severity: severityOf(finding.severity),
      message: String(finding.message),
      ...(finding.rule ? { rule: finding.rule } : {}),
      ...(finding.path ? { path: finding.path } : {}),
    })),
    sections: [...report.sections],
    omitted: omittedSections(report.designSystem),
    symbols: [...report.designSystem.symbolTable].map(([key, value]) => [key, symbolValue(value)]),
    tailwindConfig: JSON.parse(JSON.stringify(report.tailwindConfig)) as unknown,
  };
}

type EmitterOutcome = { success: true; data: unknown } | { success: false; error?: { code?: string; message?: string } };

function emitted(outcome: EmitterOutcome, text: (data: unknown) => string): DesignMdExportResult {
  if (outcome.success) return { success: true, text: text(outcome.data) };
  const { code, message } = outcome.error ?? {};
  return { success: false, errors: [[code, message].filter(Boolean).join(": ") || "The export failed."] };
}

function exportResult(report: LintReport, format: string): DesignMdExportResult {
  const state = report.designSystem;
  switch (format) {
    case "css-tailwind":
      return emitted(new TailwindV4EmitterHandler().execute(state) as EmitterOutcome, (data) =>
        serializeTailwindV4((data as { theme: Parameters<typeof serializeTailwindV4>[0] }).theme),
      );
    case "css-vars":
      return emitted(new CssVarsEmitterHandler().execute(state) as EmitterOutcome, (data) =>
        serializeCssVars((data as { declarations: Parameters<typeof serializeCssVars>[0] }).declarations),
      );
    case "dtcg":
      return emitted(new DtcgEmitterHandler().execute(state) as EmitterOutcome, (data) =>
        JSON.stringify(data, null, 2),
      );
    case "json-tailwind":
      return emitted(report.tailwindConfig as EmitterOutcome, (data) => JSON.stringify(data, null, 2));
    default:
      return { success: false, errors: ["Unknown export format."] };
  }
}

parentPort?.on("message", (request: DesignMdWorkerRequest) => {
  let report: LintReport;
  try {
    report = lint(String(request.content));
  } catch {
    parentPort?.postMessage({ ok: false, code: "lint-failed" });
    return;
  }
  try {
    parentPort?.postMessage({
      ok: true,
      result: request.op === "export" ? exportResult(report, request.format) : lintResult(report),
    });
  } catch {
    parentPort?.postMessage({ ok: false, code: request.op === "export" ? "emit-failed" : "lint-failed" });
  }
});
parentPort?.postMessage({ ready: true });
