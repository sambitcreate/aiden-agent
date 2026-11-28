// The buttons at the end of a page's, artifact's or image's title row: Open
// full window and Download. Download saves a PNG, a PDF or the original file;
// the PDF's paper and layout are set in the same menu and kept on the frame.
// A live app frame (Phase 3a, D16) has a Dark switch and Download (PNG or
// PDF) only: no full window, no paper or layout, no original file. With
// design live on (3c, S92, S93), its device button comes first and More
// last; a narrow frame folds Dark and Download into More.

import { Download, Maximize2, Moon } from "lucide-react";
import * as React from "react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../../components/ui";
import { useAppCapabilities } from "../../lib/app-capabilities";
import { AppDeviceMenu, AppMoreMenu } from "../app-frame-menus";
import { designExportFormats, type DesignExportFormat } from "../../shared/design-canvas/frame-export";
import type { DesignFrame, DesignPaper, DesignPrintMode } from "../../shared/design-canvas/schema";
import { useDesignNodeContext } from "./design-node-context";

const FORMAT_LABELS: Readonly<Record<DesignExportFormat, string>> = {
  png: "PNG image",
  pdf: "PDF",
  source: "Original file",
};

export function FrameActions({ frame, compact = false }: { frame: DesignFrame; /** A narrow frame's header (3c). */ compact?: boolean }) {
  const canvas = useDesignNodeContext();
  const { designLive } = useAppCapabilities();
  const formats = designExportFormats(frame);
  const app = frame.kind === "app";
  const pdf = formats.includes("pdf") && !app;
  const dark = frame.colorScheme === "dark";
  const name = frame.title || "frame";
  // Clicks here are the buttons', never a press that drags or selects the frame.
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  const live = app && designLive;
  // A narrow live frame's header keeps the device button and More; Dark and Download move into More.
  const fold = live && compact;
  const toggleDark = () => canvas.update(frame.id, { colorScheme: dark ? undefined : "dark" }, { record: true });
  return (
    <div className="flex items-center gap-0.5" onDoubleClick={stop} onPointerDown={stop}>
      {live ? <AppDeviceMenu frame={frame} compact={compact} onViewport={(viewport) => canvas.setViewport(frame.id, viewport)} /> : null}
      {fold ? null : app ? (
        <Button
          iconOnly
          size="small"
          variant="transparent"
          aria-label={`Show ${name} dark`}
          aria-pressed={dark}
          title="Dark"
          onClick={toggleDark}
        >
          <Moon aria-hidden />
        </Button>
      ) : (
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
      )}
      {formats.length > 0 && !fold ? (
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
      {live ? (
        <AppMoreMenu
          frame={frame}
          onAddView={(size) => canvas.addAppView(frame.id, size)}
          onDuplicate={() => canvas.duplicateAppPage(frame.id)}
          onTrash={() => canvas.trashAppPage(frame.id)}
          onRemove={() => canvas.remove(frame.id)}
          folded={
            fold ? (
              <>
                <DropdownMenuCheckboxItem checked={dark} onCheckedChange={toggleDark}>
                  Dark
                </DropdownMenuCheckboxItem>
                {formats.length > 0 ? (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Download</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="min-w-44">
                      {formats.map((format) => (
                        <DropdownMenuItem key={format} onSelect={() => canvas.download(frame.id, format)}>
                          {FORMAT_LABELS[format]}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ) : null}
                <DropdownMenuSeparator />
              </>
            ) : undefined
          }
        />
      ) : null}
    </div>
  );
}
