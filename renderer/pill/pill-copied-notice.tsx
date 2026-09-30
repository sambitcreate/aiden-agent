// Result shown in the dictation pill when a transcript was left on the
// clipboard instead of being pasted automatically.

import { ClipboardCopy, ShieldAlert } from "lucide-react";
import type { DictationCopiedReason } from "../shared/dictation";

export interface PillCopiedNoticeProps {
  reason?: DictationCopiedReason;
  message?: string;
}

const SECURE_INPUT_EXPLANATION =
  "macOS Secure Input is on — usually a password field or a terminal's Secure Keyboard Entry — so automatic paste would be blocked.";

function copiedMessage({ reason, message }: PillCopiedNoticeProps): string {
  if (message) return message;
  if (reason === "accessibility-required") return "Copied — allow Accessibility to paste";
  if (reason === "secure-input") return "Transcript copied — press ⌘V to paste.";
  return "Copied to clipboard";
}

export function PillCopiedNotice(props: PillCopiedNoticeProps) {
  const detail = copiedMessage(props);
  if (props.reason === "secure-input") {
    // Warning, not error: the transcript is safe on the clipboard. Status color
    // stays in the icon and label per the design guide.
    return (
      <>
        <ShieldAlert className="size-4 shrink-0 text-support-warning" aria-hidden="true" />
        <span className="flex max-w-56 flex-col leading-tight" title={SECURE_INPUT_EXPLANATION}>
          <span className="text-small-strong">Secure Input blocked paste</span>
          <span className="text-mini text-secondary">{detail}</span>
          <span className="sr-only">{SECURE_INPUT_EXPLANATION}</span>
        </span>
      </>
    );
  }
  return (
    <>
      <ClipboardCopy className="size-4 text-secondary" aria-hidden="true" />
      <span className="max-w-52 text-small-strong leading-tight">{detail}</span>
    </>
  );
}
