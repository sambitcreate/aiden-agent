// The buttons at the end of a page's, artifact's or image's title row: Open
// full window and Download. Download saves a PNG, a PDF or the original file;
// the PDF's paper and layout are set in the same menu and kept on the frame.

import { Download, Maximize2 } from "lucide-react";
import * as React from "react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui";
import { designExportFormats, type DesignExportFormat } from "../../shared/design-canvas/frame-export";
import type { DesignFrame, DesignPaper, DesignPrintMode } from "../../shared/design-canvas/schema";
import { useDesignNodeContext } from "./design-node-context";

const FORMAT_LABELS: Readonly<Record<DesignExportFormat, string>> = {
  png: "PNG image",
  pdf: "PDF",
  source: "Original file",
};

export function FrameActions({ frame }: { frame: DesignFrame }) {
  const canvas = useDesignNodeContext();
  const formats = designExportFormats(frame);
  const pdf = formats.includes("pdf");
  const name = frame.title || "frame";
  // Clicks here are the buttons', never a press that drags or selects the frame.
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  return (
    <div className="flex items-center gap-0.5" onDoubleClick={stop} onPointerDown={stop}>
      <Button
        iconOnly
        size="small"
        variant="transparent"
        aria-label={`Open ${name} in a full window`}
        title="Open full window"
        onClick={() => canvas.openFullWindow(frame.id)}
      >
        <Maximize2 aria-hidden />
      </Button>
      {formats.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button iconOnly size="small" variant="transparent" aria-label={`Download ${name}`} title="Download">
              <Download aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            {formats.map((format) => (
              <DropdownMenuItem key={format} onSelect={() => canvas.download(frame.id, format)}>
                {FORMAT_LABELS[format]}
              </DropdownMenuItem>
            ))}
            {pdf ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>PDF paper</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={frame.paper ?? "letter"}
                  onValueChange={(value) =>
                    canvas.update(frame.id, { paper: value === "a4" ? "a4" : undefined }, { record: true })
                  }
                >
                  <DropdownMenuRadioItem value={"letter" satisfies DesignPaper}>Letter</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value={"a4" satisfies DesignPaper}>A4</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuLabel>PDF layout</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={frame.printMode ?? "flow"}
                  onValueChange={(value) =>
                    canvas.update(frame.id, { printMode: value === "fixed" ? "fixed" : undefined }, { record: true })
                  }
                >
                  <DropdownMenuRadioItem value={"flow" satisfies DesignPrintMode}>Flow to the paper</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value={"fixed" satisfies DesignPrintMode}>Fixed at design width</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
