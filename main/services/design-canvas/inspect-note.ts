import { formatCheckReport } from "../check-report.js";
import { DESIGN_INSPECT_PAGE_DATA_LINE } from "./inspect.js";

/**
 * After Aiden writes a design page, the page is drawn offline (text report
 * only, no picture) and what was found goes to the conversation as a note
 * before its next request, so a script error or a missing file is fixed in
 * the same turn without Aiden having to ask.
 *
 * The note is a system section patch on the transcript, as the canvas status
 * note is, journaled where it sits (the harness's `durableSections`) and kept
 * in place by compaction. A model that takes system messages mid-conversation
 * reads it there, so the prefix before it, and its cache, hold. Any other
 * model has every system message folded into the leading system prompt, the
 * newest report replacing the last under the same section name, so for it a
 * new report changes the system prompt and the next request is read without
 * the cache. What the page chose (messages, addresses, names) is cut short and
 * quoted in each finding, and the note says it is data, since it is read with
 * system authority.
 */

/** The transcript section that carries the report on pages Aiden just wrote. */
export const DESIGN_PAGE_INSPECT_SECTION = "design-page-inspect";

/** Pages reported in one note; a step that wrote more names only how many were left out. */
export const DESIGN_PAGE_INSPECT_NOTE_MAX_PAGES = 5;
/** How long a request waits for reports still being drawn; later ones go with a later request. */
export const DESIGN_PAGE_INSPECT_WAIT_MS = 6_000;

export type WrittenPageReport = {
  /** The page's workspace path, such as design/home.html. */
  path: string;
  /** One sentence per problem; empty when nothing is wrong. */
  findings: readonly string[];
};

/** The note's text: one line per clean page, one short report per page with problems. */
export function designInspectNoteText(reports: readonly WrittenPageReport[]): string {
  const shown = reports.slice(0, DESIGN_PAGE_INSPECT_NOTE_MAX_PAGES);
  const lines = [
    `Checked ${reports.length === 1 ? "the page" : "the pages"} you just wrote, drawn offline at the design width with the frame's look (text only; canvas_inspect gives a picture):`,
  ];
  for (const report of shown) {
    lines.push(
      formatCheckReport({
        label: report.path,
        findings: report.findings,
        fix: "Fix them in the file once; another report follows the next write.",
      }).trimStart(),
    );
  }
  const left = reports.length - shown.length;
  if (left > 0) lines.push(`${left} more ${left === 1 ? "page was" : "pages were"} written; call canvas_inspect to check ${left === 1 ? "it" : "them"}.`);
  if (shown.some((report) => report.findings.length > 0)) lines.push(DESIGN_INSPECT_PAGE_DATA_LINE);
  return lines.join("\n");
}

/**
 * Adds the report on the pages written since the last request to the end of
 * the conversation. Unlike the canvas status note, a report that reads the
 * same as the last one is still added: it answers a new write, and a fix that
 * did not work must say so.
 */
export function withDesignInspectNote<C extends { messages: readonly unknown[] }>(
  context: C,
  reports: readonly WrittenPageReport[],
  now: number,
): C {
  if (reports.length === 0) return context;
  return {
    ...context,
    messages: [
      ...context.messages,
      { role: "system", content: "", sections: { [DESIGN_PAGE_INSPECT_SECTION]: designInspectNoteText(reports) }, timestamp: now },
    ],
  };
}

export type WrittenPageInspector = {
  /** A page was written and placed: inspect it, after any inspect already running. */
  written(path: string): void;
  /** The reports finished since the last call, in the order they finished, waiting up to `waitMs` for ones still running. */
  take(waitMs?: number, signal?: AbortSignal): Promise<WrittenPageReport[]>;
};

/**
 * Inspects written pages one at a time. A page written again before its
 * inspect starts is inspected once, and a report for a page written again
 * since is dropped for the newer one, so a report always describes the page
 * as it now is. `inspect` returning null (no frame shows the page, or design
 * mode was left) reports nothing; a failed inspect goes to `onError`.
 */
export function createWrittenPageInspector(options: {
  inspect: (path: string) => Promise<readonly string[] | null>;
  onError: (path: string, error: unknown) => void;
}): WrittenPageInspector {
  const writes = new Map<string, number>();
  const ready = new Map<string, WrittenPageReport>();
  let chain: Promise<void> = Promise.resolve();
  return {
    written(path) {
      const generation = (writes.get(path) ?? 0) + 1;
      writes.set(path, generation);
      ready.delete(path);
      chain = chain.then(async () => {
        if (writes.get(path) !== generation) return;
        try {
          const findings = await options.inspect(path);
          if (findings && writes.get(path) === generation) ready.set(path, { path, findings: [...findings] });
        } catch (error) {
          options.onError(path, error);
        }
      });
    },
    async take(waitMs = DESIGN_PAGE_INSPECT_WAIT_MS, signal) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stop: (() => void) | undefined;
      await Promise.race([
        chain,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs);
          stop = () => resolve();
          signal?.addEventListener("abort", stop, { once: true });
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (stop) signal?.removeEventListener("abort", stop);
      const reports = [...ready.values()];
      ready.clear();
      return reports;
    },
  };
}
