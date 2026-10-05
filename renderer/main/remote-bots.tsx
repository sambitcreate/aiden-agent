import * as React from "react";
import { skipToken, useQueries, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { RemoteBotsSection } from "../components/remote-bots-section";
import { toast } from "../components/ui";
import { hostQueryKeys } from "../lib/hosts/host-query-keys";
import { remoteBotGroups } from "../lib/hosts/new-chat-targets";
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
 * The Bots area's paired-Mac section. Bots come from each host's last-known
 * feed; opening one asks that host for the Bot's chat and opens it there.
 * One control per host is kept while the view is open, so a retry after a
 * lost answer reuses its key.
 */
export function RemoteBots() {
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

  return <RemoteBotsSection groups={groups} opening={opening} onOpen={(hostId, botId) => void open(hostId, botId)} />;
}
