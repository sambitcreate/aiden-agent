import * as React from "react";
import { defineCatalog, type Spec } from "@json-render/core";
import { defineRegistry, JSONUIProvider, Renderer } from "@json-render/react";
import { schema } from "@json-render/react/schema";
import { z } from "zod";
import {
  Button,
  Switch,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Dialog,
} from "./ui";
import { MemoryCardIcon } from "./memory-card-icon";
import { appControlsApi } from "../lib/ipc";
import type {
  AppControlPanel,
  AppControlRow,
  AppControlSnapshot,
  AppControlOperation,
} from "../shared/app-controls";

const catalog = defineCatalog(schema, {
  components: {
    SettingsGroup: { props: z.object({}), slots: ["default"], description: "Owned settings rows." },
    SettingControl: {
      props: z.object({ controlRef: z.string().max(80) }),
      description: "One host-owned current preference.",
    },
  },
  actions: {},
});
interface ControlContext {
  snapshot: AppControlSnapshot;
  pending?: string;
  change(row: AppControlRow, value: string | boolean): void;
}
const Context = React.createContext<ControlContext | null>(null);
function SettingControl({ controlRef }: { controlRef: string }) {
  const context = React.useContext(Context)!;
  const row = context.snapshot.rows.find((row) => row.id === controlRef);
  const id = React.useId();
  if (!row) return null;
  const busy = context.pending === row.id;
  return (
    <div className="flex min-w-0 items-center justify-between gap-4 py-3 [&+&]:border-t [&+&]:border-separator">
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="text-small font-medium">
          {row.label}
        </label>
        <p className="text-mini text-secondary">{row.description}</p>
        <p className="text-mini text-tertiary">{row.scope}</p>
        {row.disabledReason ? (
          <p className="text-mini text-secondary">{row.disabledReason}</p>
        ) : null}
      </div>
      {row.options ? (
        <Select
          value={String(row.value)}
          disabled={Boolean(context.pending) || Boolean(row.disabledReason)}
          onValueChange={(value) => context.change(row, value)}
        >
          <SelectTrigger id={id} aria-label={`${row.label} — ${row.scope}`} className="max-w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {row.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Switch
          id={id}
          checked={row.value === true}
          disabled={Boolean(context.pending) || Boolean(row.disabledReason)}
          aria-label={`${row.label} — ${row.scope}`}
          onCheckedChange={(value) => context.change(row, value)}
        />
      )}
      {busy ? <span className="sr-only">Saving</span> : null}
    </div>
  );
}
const { registry } = defineRegistry(catalog, {
  components: {
    SettingsGroup: ({ children }) => <div className="px-4">{children}</div>,
    SettingControl: ({ props }) => <SettingControl controlRef={props.controlRef} />,
  },
});
export function AppControlsView({ snapshot, pending, change }: ControlContext) {
  return (
    <Context.Provider value={{ snapshot, pending, change }}>
      <JSONUIProvider registry={registry}>
        <Renderer spec={appControlsSpec(snapshot)} registry={registry} />
      </JSONUIProvider>
    </Context.Provider>
  );
}
export function appControlsSpec(snapshot: AppControlSnapshot): Spec {
  return {
    root: "group",
    elements: {
      group: { type: "SettingsGroup", props: {}, children: snapshot.rows.map((row) => row.id) },
      ...Object.fromEntries(
        snapshot.rows.map((row) => [
          row.id,
          { type: "SettingControl", props: { controlRef: row.id } },
        ]),
      ),
    },
  };
}
export function AppControlsPanel({ panel, chatId }: { panel: AppControlPanel; chatId: string }) {
  const ref = React.useRef<HTMLElement>(null);
  const [visible, setVisible] = React.useState(false);
  const [snapshot, setSnapshot] = React.useState<AppControlSnapshot>();
  const [pending, setPending] = React.useState<string>();
  const [message, setMessage] = React.useState("");
  const [confirmation, setConfirmation] = React.useState<AppControlOperation>();
  const owner = React.useRef(0);
  const applying = React.useRef(false);
  const retry = React.useRef<AppControlOperation | undefined>(undefined);
  const refresh = React.useCallback(async () => {
    const epoch = owner.current;
    try {
      const next = await appControlsApi.get(chatId, panel.id);
      if (epoch === owner.current) setSnapshot(next);
    } catch {
      if (epoch === owner.current) {
        setSnapshot(undefined);
        setMessage("Current settings are unavailable. Refresh when the host is connected.");
      }
    }
  }, [chatId, panel.id]);
  React.useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      rootMargin: "100px",
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  React.useEffect(() => {
    owner.current += 1;
    if (!visible) return;
    void refresh();
    const unsubscribe = appControlsApi.onChanged(() => {
      void refresh();
    });
    return () => {
      owner.current += 1;
      unsubscribe();
    };
  }, [refresh, visible]);
  const apply = async (operation: AppControlOperation) => {
    if (applying.current) return;
    applying.current = true;
    const epoch = owner.current;
    setPending(operation.control);
    setMessage("");
    retry.current = operation;
    try {
      const receipt = await appControlsApi.apply(chatId, panel.id, operation);
      if (epoch !== owner.current) return;
      if (receipt.status === "outcome_unknown")
        setMessage(
          "This change could not be confirmed. Refresh its current value; checking the change will not repeat it.",
        );
      else {
        retry.current = undefined;
        setMessage(
          receipt.warning ??
            (receipt.effective === "now" ? "Saved." : "Saved. Applies to subsequent agent work."),
        );
      }
    } catch (error) {
      if (epoch === owner.current)
        setMessage(error instanceof Error ? error.message : "Change could not be confirmed.");
    } finally {
      applying.current = false;
      setPending(undefined);
      if (epoch === owner.current) await refresh();
    }
  };
  const change = (row: AppControlRow, value: string | boolean) => {
    if (pending || value === row.value || row.disabledReason) return;
    const operation = {
      control: row.id,
      value,
      expectedRevision: row.revision,
      operationId: crypto.randomUUID(),
    };
    if (snapshot?.policy === "ask" || value === true) setConfirmation(operation);
    else void apply(operation);
  };
  return (
    <section
      ref={ref}
      aria-label={`${panel.topic} controls`}
      className="my-2 min-w-0 rounded-2xl bg-control"
    >
      <div className="flex items-center gap-2 px-4 pt-4">
        {panel.topic === "memory" ? <MemoryCardIcon aria-hidden="true" className="size-4" /> : null}
        <h3 className="text-small font-semibold">{snapshot?.title ?? "Aiden settings"}</h3>
        <span className="ml-auto text-mini text-secondary">
          {snapshot?.target ?? "Current settings"}
        </span>
      </div>
      {snapshot ? (
        <AppControlsView snapshot={snapshot} pending={pending} change={change} />
      ) : (
        <p className="px-4 py-3 text-small text-secondary">{panel.fallback}</p>
      )}
      <div className="flex items-center gap-2 px-4 pb-3">
        <p role="status" className="flex-1 text-mini text-secondary">
          {message}
        </p>
        {retry.current && !pending ? (
          <Button
            size="small"
            onClick={() => {
              void apply(retry.current!);
            }}
          >
            Check change
          </Button>
        ) : null}
        <Button
          size="small"
          variant="transparent"
          disabled={Boolean(pending)}
          onClick={() => {
            void refresh();
          }}
        >
          Refresh
        </Button>
      </div>
      <Dialog
        open={Boolean(confirmation)}
        onOpenChange={(open) => {
          if (!open) setConfirmation(undefined);
        }}
        title={`Change ${snapshot?.rows.find((row) => row.id === confirmation?.control)?.label ?? "preference"}?`}
        description={`This changes ${snapshot?.rows.find((row) => row.id === confirmation?.control)?.scope ?? "this host"}. Existing permissions and setup still apply.`}
        confirmLabel="Apply change"
        onConfirm={() => {
          const operation = confirmation;
          setConfirmation(undefined);
          if (operation) void apply(operation);
        }}
      />
    </section>
  );
}
