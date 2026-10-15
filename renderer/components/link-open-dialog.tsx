import * as React from "react";
import { Copy } from "lucide-react";
import { Button, Dialog, Text, toast } from "./ui";

export type LinkOpenChoice = { target: "browser" | "external"; remember: boolean };

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * First-click confirmation before Aiden opens a link: lets the person pick
 * the in-app browser or their system browser, optionally remembering the
 * choice. Rendered by `LinkOpenerProvider` whenever the router returns
 * `{ kind: "ask" }`.
 */
export function LinkOpenDialog({
  url,
  rememberable,
  inApp,
  onChoose,
  onCancel,
}: {
  url: string | null;
  /** False for aiden-ui / restricted Markdown: the choice is never remembered. */
  rememberable: boolean;
  /** False when the panel can't show: only the system browser is offered. */
  inApp: boolean;
  onChoose: (choice: LinkOpenChoice) => void;
  onCancel: () => void;
}) {
  const [remember, setRemember] = React.useState(true);
  React.useEffect(() => {
    if (url) setRemember(true);
  }, [url]);

  const choose = (target: LinkOpenChoice["target"]) =>
    onChoose({ target, remember: rememberable && remember });

  const copyLink = () => {
    if (!url) return;
    void navigator.clipboard
      .writeText(url)
      .then(() => toast.success("Link copied."))
      .catch(() => toast.error("Couldn't copy the link."));
  };

  return (
    <Dialog
      open={url !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title="Open this link?"
      description={url ? hostOf(url) : undefined}
      confirmLabel={inApp ? "Open in Aiden browser" : "Open in system browser"}
      onConfirm={() => choose(inApp ? "browser" : "external")}
    >
      <Text as="p" variant="small" color="secondary" className="m-0 break-all select-text">
        {url}
      </Text>
      {rememberable ? (
        <>
          <label className="mt-3 flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5 shrink-0 accent-accent"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
              aria-describedby="link-open-remember-hint"
            />
            <span>Remember my choice</span>
          </label>
          <Text as="p" id="link-open-remember-hint" variant="small" color="tertiary" className="m-0 mt-1 ml-6">
            You can change this in Settings → Links.
          </Text>
        </>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="transparent" onClick={copyLink}>
          <Copy aria-hidden="true" className="size-4" />
          Copy link
        </Button>
        {inApp ? (
          <Button variant="muted" className="ml-auto" onClick={() => choose("external")}>
            Open in system browser
          </Button>
        ) : null}
      </div>
    </Dialog>
  );
}
