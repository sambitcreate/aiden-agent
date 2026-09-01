import * as React from "react";
import { Download, Pencil, Trash2 } from "lucide-react";
import {
  AlertDialog,
  Button,
  Dialog,
  Switch,
  Text,
  Textarea,
  toast,
} from "./ui";
import { chatsApi, type MemoryFactView } from "../lib/ipc";

function sourceLabel(fact: MemoryFactView): string {
  if (fact.provenance.kind === "chat_message") {
    return `Chat message · ${fact.provenance.messageId}`;
  }
  return fact.provenance.kind === "model_proposal" ? "Approved model suggestion" : "Edited by you";
}

function expiryLabel(expiresAt: number | undefined): string | undefined {
  if (expiresAt === undefined) return undefined;
  return expiresAt <= Date.now()
    ? "Expired"
    : `Expires ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(expiresAt)}`;
}

export function MemoryDialog({
  chatId,
  open,
  onOpenChange,
}: {
  chatId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [facts, setFacts] = React.useState<MemoryFactView[]>([]);
  const [scopeKind, setScopeKind] = React.useState<"bot" | "workspace" | null>(null);
  const [fact, setFact] = React.useState("");
  const [alwaysOn, setAlwaysOn] = React.useState(false);
  const [supersedesId, setSupersedesId] = React.useState<string | undefined>();
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<MemoryFactView | null>(null);
  const requestRef = React.useRef(0);

  const resetEditor = React.useCallback(() => {
    setFact("");
    setAlwaysOn(false);
    setSupersedesId(undefined);
  }, []);

  const load = React.useCallback(async () => {
    const request = requestRef.current + 1;
    requestRef.current = request;
    setLoading(true);
    setError(null);
    try {
      const next = await chatsApi.memoryList(chatId);
      if (requestRef.current === request) {
        setFacts(next.facts);
        setScopeKind(next.scope.kind);
      }
    } catch (loadError) {
      if (requestRef.current === request) {
        setError(loadError instanceof Error ? loadError.message : "Aiden couldn't load memory.");
      }
    } finally {
      if (requestRef.current === request) setLoading(false);
    }
  }, [chatId]);

  React.useEffect(() => {
    if (!open) {
      requestRef.current += 1;
      resetEditor();
      setDeleting(null);
      setError(null);
      return;
    }
    void load();
  }, [load, open, resetEditor]);

  const save = async () => {
    if (!fact.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await chatsApi.memoryPut(chatId, {
        fact,
        alwaysOn,
        ...(supersedesId ? { supersedesId } : {}),
      });
      resetEditor();
      await load();
      toast.success(supersedesId ? "Memory updated." : "Memory added.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Aiden couldn't save memory.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!deleting || saving) return;
    setSaving(true);
    setError(null);
    try {
      await chatsApi.memoryRemove(chatId, deleting.id);
      if (supersedesId === deleting.id) resetEditor();
      setDeleting(null);
      await load();
      toast.success("Memory deleted.");
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Aiden couldn't delete memory.");
    } finally {
      setSaving(false);
    }
  };

  const exportMemory = async () => {
    if (exporting) return;
    setExporting(true);
    setError(null);
    try {
      const result = await chatsApi.memoryExport(chatId);
      if (result.status === "saved") toast.success("Memory exported.");
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Aiden couldn't export memory.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => !saving && !exporting && onOpenChange(nextOpen)}
        title="Memory"
        description={
          <>
            Approved facts stay on this Mac and are isolated to {scopeKind ? `this ${scopeKind}` : "the current workspace or Bot"}.
            Aiden treats them as data, never as instructions or permissions.
          </>
        }
        size="large"
        confirmLabel={saving ? "Saving…" : supersedesId ? "Save replacement" : "Add fact"}
        confirmDisabled={!fact.trim() || saving || exporting}
        dismissDisabled={saving || exporting}
        onConfirm={save}
      >
        <div data-memory-dialog className="grid gap-4">
          <div className="grid gap-2">
            <label htmlFor="memory-fact" className="text-small-strong text-primary">
              {supersedesId ? "Replace fact" : "New fact"}
            </label>
            <Textarea
              id="memory-fact"
              value={fact}
              maxLength={512}
              disabled={saving}
              placeholder="A concise preference or durable project fact"
              onChange={(event) => setFact(event.target.value)}
              autoFocus
            />
            <div className="flex items-center justify-between gap-4 rounded-control bg-well px-3 py-2.5">
              <div>
                <Text as="div" variant="small-strong">Always include</Text>
                <Text as="div" variant="small" color="secondary">
                  Keep this in the small prompt prefix instead of recalling it on demand.
                </Text>
              </div>
              <Switch
                checked={alwaysOn}
                disabled={saving}
                aria-label="Always include this fact"
                onCheckedChange={setAlwaysOn}
              />
            </div>
            {supersedesId ? (
              <Button variant="transparent" size="small" className="justify-self-start" onClick={resetEditor}>
                Cancel replacement
              </Button>
            ) : null}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-separator pt-4">
            <Text variant="small-strong">Approved facts</Text>
            <Button
              variant="transparent"
              size="small"
              disabled={loading || exporting || facts.length === 0}
              onClick={() => void exportMemory()}
            >
              <Download /> {exporting ? "Exporting…" : "Export JSON"}
            </Button>
          </div>

          {error ? <div role="alert" className="rounded-control bg-red/10 px-3 py-2 text-small text-red">{error}</div> : null}
          {loading ? (
            <Text as="div" variant="small" color="secondary">Loading approved facts…</Text>
          ) : facts.length === 0 ? (
            <div className="rounded-card bg-well px-4 py-5 text-center">
              <Text as="div" variant="small-strong">No saved facts yet</Text>
              <Text as="div" variant="small" color="secondary" className="mt-1">
                Add only information that should carry into future turns in this scope.
              </Text>
            </div>
          ) : (
            <ul className="grid gap-2" aria-label="Approved memory facts">
              {facts.map((item) => {
                const expiry = expiryLabel(item.expiresAt);
                return (
                  <li key={item.id} className="rounded-card bg-well px-3 py-3">
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <Text as="p" variant="regular" className={item.state === "superseded" ? "text-tertiary line-through" : undefined}>
                          {item.text}
                        </Text>
                        <div className="mt-1 flex flex-wrap gap-x-2 text-mini text-tertiary">
                          <span>{sourceLabel(item)}</span>
                          <span>{item.alwaysOn ? "Always included" : "On-demand"}</span>
                          {item.state === "superseded" ? <span>Replaced</span> : null}
                          {expiry ? <span>{expiry}</span> : null}
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        {item.state === "active" ? (
                          <Button
                            iconOnly
                            variant="transparent"
                            size="small"
                            aria-label={`Replace memory: ${item.text}`}
                            disabled={saving}
                            onClick={() => {
                              setFact(item.text);
                              setAlwaysOn(item.alwaysOn);
                              setSupersedesId(item.id);
                            }}
                          >
                            <Pencil />
                          </Button>
                        ) : null}
                        <Button
                          iconOnly
                          variant="transparent"
                          size="small"
                          aria-label={`Delete memory: ${item.text}`}
                          disabled={saving}
                          onClick={() => setDeleting(item)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Dialog>
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(nextOpen) => !nextOpen && !saving && setDeleting(null)}
        title="Delete this memory?"
        description={deleting?.text}
        confirmLabel={saving ? "Deleting…" : "Delete"}
        confirmVariant="destructive"
        busy={saving}
        onConfirm={remove}
      />
    </>
  );
}
