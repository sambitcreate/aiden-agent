import { skipToken, useQuery } from "@tanstack/react-query";
import { Globe } from "lucide-react";
import { EmptyState } from "../components/ui";
import { hostQueryKeys } from "../lib/hosts/host-query-keys";
import { sidebarHosts } from "../lib/sidebar-remote-groups";
import type { PeerHostFeedSnapshot, PeerHostStatus, PeerHostView } from "../shared/peer-host";

/**
 * Placeholder pane for `/host/$hostId/chat/$chatId`. It reads only what the
 * sidebar store already cached and never contacts the host; the remote chat
 * pane replaces it.
 */
export function RemoteChatPlaceholder({ hostId, chatId }: { hostId: string; chatId: string }) {
  const list = useQuery<PeerHostView[]>({ queryKey: hostQueryKeys.list(), queryFn: skipToken });
  const statuses = useQuery<PeerHostStatus[]>({
    queryKey: hostQueryKeys.statuses(),
    queryFn: skipToken,
  });
  const feed = useQuery<PeerHostFeedSnapshot | null>({
    queryKey: hostQueryKeys.feed(hostId),
    queryFn: skipToken,
  });
  const host = sidebarHosts(list.data ?? [], statuses.data ?? []).find((entry) => entry.id === hostId);
  const summary = feed.data?.summaries.find((row) => row.id === chatId);
  const hostLabel = host?.label ?? "another Mac";
  const title =
    typeof summary?.title === "string" && summary.title.trim() ? summary.title : "Remote chat";

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center" data-remote-chat-placeholder="true">
      <Globe className="size-6 text-tertiary" aria-hidden="true" />
      <EmptyState
        title={summary ? title : "Chat not found"}
        description={
          summary
            ? `This chat runs on ${hostLabel}. Opening chats from another Mac is coming in a later update.`
            : `This chat is no longer listed on ${hostLabel}.`
        }
      />
    </div>
  );
}
