import * as React from "react";
import { skipToken, useQueries, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "../components/ui";
import { hostQueryKeys } from "../lib/hosts/host-query-keys";
import { remoteBotGroups, type RemoteBotGroup } from "../lib/hosts/new-chat-targets";
import { hostSharesBotSessions } from "../lib/hosts/remote-bot-session";
import { RemoteHostAdapter } from "../lib/hosts/remote-host-adapter";
import { RemoteNewChatControl } from "../lib/hosts/remote-new-chat";
import type { PeerHostFeedSnapshot, PeerHostStatus, PeerHostView } from "../shared/peer-host";

interface HostBotControl {
  grants: string;
  adapter: RemoteHostAdapter;
  control: RemoteNewChatControl;
  detach(): void;
}

function grantsOf(view: PeerHostView): string {
  return `${view.features.join(",")}|${view.capabilities.join(",")}`;
}

/**
 * The Bots on paired Macs, for the Bots sidebar. Bots come from each host's last-known
 * feed. Opening one shows its one durable conversation on that host; a host too
 * old to share it gets the Bot's workspace chat instead.
 * One control per host is kept while the view is open, so a retry after a
 * lost answer reuses its key.
 */
export function useRemoteBots(): {
  groups: RemoteBotGroup[];
  /** `hostId/botId` of the Bot whose chat is being opened. */
  opening: string | null;
  open(hostId: string, botId: string): void;
} {
  const navigate = useNavigate();
  const list = useQuery<PeerHostView[]>({ queryKey: hostQueryKeys.list(), queryFn: skipToken });
  const statuses = useQuery<PeerHostStatus[]>({ queryKey: hostQueryKeys.statuses(), queryFn: skipToken });
  const views = React.useMemo(() => (list.data ?? []).filter((view) => view.enabled), [list.data]);
  const feeds = useQueries({
    queries: views.map((view) => ({ queryKey: hostQueryKeys.feed(view.id), queryFn: skipToken })),
    combine: (results) =>
      new Map(views.map((view, index) => [view.id, results[index]?.data as PeerHostFeedSnapshot | null | undefined])),
  });
  const groups = React.useMemo(() => remoteBotGroups(views, statuses.data ?? [], feeds), [views, statuses.data, feeds]);
  const [opening, setOpening] = React.useState<string | null>(null);
  const controls = React.useRef(new Map<string, HostBotControl>());

  React.useEffect(() => {
    const owned = controls.current;
    return () => {
      for (const entry of owned.values()) {
        entry.detach();
        entry.adapter.dispose();
      }
      owned.clear();
    };
  }, []);

  const controlFor = async (view: PeerHostView): Promise<RemoteNewChatControl> => {
    const grants = grantsOf(view);
    const current = controls.current.get(view.id);
    if (current && current.grants === grants) return current.control;
    if (current) {
      current.detach();
      current.adapter.dispose();
    }
    const adapter = new RemoteHostAdapter(view);
    const control = new RemoteNewChatControl(adapter);
    const detach = control.attach();
    controls.current.set(view.id, { grants, adapter, control, detach });
    await adapter.ready();
    return control;
  };

  const open = async (hostId: string, botId: string) => {
    const view = views.find((entry) => entry.id === hostId);
    if (!view || opening) return;
    if (hostSharesBotSessions(view)) {
      await navigate({ to: "/host/$hostId/bots/$botId/chat", params: { hostId, botId } });
      return;
    }
    setOpening(`${hostId}/${botId}`);
    try {
      const control = await controlFor(view);
      const chatId = await control.openBotChat(botId);
      await navigate({ to: "/host/$hostId/chat/$chatId", params: { hostId, chatId } });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That Bot's chat could not be opened.");
    } finally {
      setOpening(null);
    }
  };

  // `open` keeps one identity, so callers can depend on it without re-running each render.
  const openRef = React.useRef(open);
  openRef.current = open;
  const stableOpen = React.useCallback((hostId: string, botId: string) => void openRef.current(hostId, botId), []);
  return { groups, opening, open: stableOpen };
}
