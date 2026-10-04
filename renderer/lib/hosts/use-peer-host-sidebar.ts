import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { peerHostsApi, workspacesApi } from "../ipc";
import { sidebarHosts, type SidebarHost } from "../sidebar-remote-groups";
import type {
  PeerHostFeedMessage,
  PeerHostFeedSnapshot,
  PeerRepositoryIdentity,
} from "../../shared/peer-host";
import { hostQueryKeys } from "./host-query-keys";
import { animationFrame } from "./frame-scheduler";
import {
  createPeerHostFeedBatcher,
  createPeerHostStatusSync,
  FEED_RESYNC,
  replayPeerHostFeedMessages,
} from "./peer-host-feed-state";

/** A snapshot that keeps racing a reset is re-read at most this many times per fetch. */
const MAX_FEED_READS = 3;

export interface PeerHostSidebarData {
  /** Enabled paired hosts with display labels and availability. Empty when none is paired. */
  hosts: SidebarHost[];
  /** Last-known feed snapshot per host ID. */
  feeds: ReadonlyMap<string, PeerHostFeedSnapshot>;
}

const NO_FEEDS: ReadonlyMap<string, PeerHostFeedSnapshot> = new Map();

/** Stable `combine` for the feed queries; it reruns only when a result changes. */
function feedsByHost(
  results: readonly { data: PeerHostFeedSnapshot | null | undefined }[],
): ReadonlyMap<string, PeerHostFeedSnapshot> {
  const byHost = new Map<string, PeerHostFeedSnapshot>();
  for (const { data } of results) if (data) byHost.set(data.hostId, data);
  return byHost.size > 0 ? byHost : NO_FEEDS;
}

/**
 * Renderer store for paired hosts in the sidebar. It reads the registry list,
 * which never starts host supervision, and asks for statuses and feeds only
 * once an enabled host exists. Feed broadcasts are applied once per frame with the pure
 * reducer; any gap it cannot bridge triggers a fresh snapshot read.
 */
export function usePeerHostSidebar(): PeerHostSidebarData {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: hostQueryKeys.list(),
    queryFn: peerHostsApi.list,
    staleTime: Infinity,
  });
  const enabledIds = useMemo(
    () => (list.data ?? []).filter((host) => host.enabled).map((host) => host.id),
    [list.data],
  );
  const supervised = enabledIds.length > 0;

  useEffect(() => {
    const unsubscribe = peerHostsApi.onChanged(() => {
      void queryClient.invalidateQueries({ queryKey: hostQueryKeys.list() });
      void queryClient.invalidateQueries({ queryKey: hostQueryKeys.statuses() });
    });
    // A list cached by an earlier mount (before Settings replaced the chat
    // shell) may have missed changes while nothing listened; read it again.
    if (queryClient.getQueryData(hostQueryKeys.list()) !== undefined) {
      void queryClient.invalidateQueries({ queryKey: hostQueryKeys.list() });
    }
    return unsubscribe;
  }, [queryClient]);

  // Drop cached rows for hosts that were unpaired or disabled.
  useEffect(() => {
    if (!list.data) return;
    const kept = new Set(enabledIds);
    for (const query of queryClient.getQueryCache().findAll({ queryKey: ["host"] })) {
      const hostId = query.queryKey[1];
      if (typeof hostId === "string" && !kept.has(hostId)) {
        queryClient.removeQueries({ queryKey: hostQueryKeys.host(hostId) });
      }
    }
  }, [enabledIds, list.data, queryClient]);

  const statusSync = useMemo(
    () => createPeerHostStatusSync(queryClient, peerHostsApi.statuses),
    [queryClient],
  );
  // Messages that arrive while a snapshot read is in flight, per host.
  const pending = useRef(new Map<string, PeerHostFeedMessage[]>());
  // Status and feed reads wait for the broadcast listeners so no change can slip between them.
  const [listening, setListening] = useState(false);
  useEffect(() => {
    if (!supervised) return;
    const unsubscribeState = peerHostsApi.onHostState(statusSync.receive);
    // Each host's rows change at most once per frame, so a burst of feed
    // messages re-organizes the sidebar once.
    const batcher = createPeerHostFeedBatcher(animationFrame, {
      read: (hostId) => queryClient.getQueryData<PeerHostFeedSnapshot | null>(hostQueryKeys.feed(hostId)),
      write: (hostId, next) => queryClient.setQueryData(hostQueryKeys.feed(hostId), next),
      resync: (hostId) => void queryClient.invalidateQueries({ queryKey: hostQueryKeys.feed(hostId) }),
    });
    const unsubscribeFeed = peerHostsApi.onHostFeed((message) => {
      pending.current.get(message.hostId)?.push(message);
      batcher.push(message);
    });
    // Statuses and feeds cached while an earlier listener was installed may
    // have missed broadcasts since it went away. Mark them stale without
    // reading yet: the gated queries read afresh once they are enabled below.
    void queryClient.invalidateQueries({ queryKey: hostQueryKeys.statuses(), refetchType: "none" });
    void queryClient.invalidateQueries({ queryKey: ["host"], refetchType: "none" });
    setListening(true);
    return () => {
      unsubscribeState();
      unsubscribeFeed();
      batcher.dispose();
      setListening(false);
    };
  }, [queryClient, statusSync, supervised]);

  const statuses = useQuery({
    queryKey: hostQueryKeys.statuses(),
    queryFn: statusSync.read,
    enabled: supervised && listening,
    staleTime: Infinity,
  });

  const feeds = useQueries({
    queries: enabledIds.map((hostId) => ({
      queryKey: hostQueryKeys.feed(hostId),
      queryFn: async (): Promise<PeerHostFeedSnapshot | null> => {
        for (let read = 0; read < MAX_FEED_READS; read += 1) {
          const buffered: PeerHostFeedMessage[] = [];
          pending.current.set(hostId, buffered);
          try {
            const snapshot = await peerHostsApi.feed(hostId);
            if (!snapshot) return null;
            const replayed = replayPeerHostFeedMessages(snapshot, buffered);
            if (replayed !== FEED_RESYNC) return replayed;
          } finally {
            if (pending.current.get(hostId) === buffered) pending.current.delete(hostId);
          }
        }
        throw new Error("The host's rows kept changing while they were read.");
      },
      enabled: listening,
      staleTime: Infinity,
    })),
    combine: feedsByHost,
  });

  const hosts = useMemo(
    () => (supervised ? sidebarHosts(list.data ?? [], statuses.data ?? []) : []),
    [list.data, statuses.data, supervised],
  );
  return { hosts, feeds };
}

const NO_IDENTITIES: ReadonlyMap<string, PeerRepositoryIdentity | null> = new Map();

function identitiesById(
  results: readonly {
    data: { workspaceId: string; identity: PeerRepositoryIdentity | null } | undefined;
  }[],
): ReadonlyMap<string, PeerRepositoryIdentity | null> {
  const byId = new Map<string, PeerRepositoryIdentity | null>();
  for (const { data } of results) if (data) byId.set(data.workspaceId, data.identity);
  return byId.size > 0 ? byId : NO_IDENTITIES;
}

/**
 * This Mac's repository identity per workspace, read only while a
 * cross-machine grouping needs it. Main answers from its cached repository read.
 */
export function useLocalRepositoryIdentities(
  workspaceIds: readonly string[],
  enabled: boolean,
): ReadonlyMap<string, PeerRepositoryIdentity | null> {
  return useQueries({
    queries: (enabled ? workspaceIds : []).map((workspaceId) => ({
      queryKey: ["repository-identity", workspaceId] as const,
      queryFn: async () => ({
        workspaceId,
        identity: await workspacesApi.repositoryIdentity(workspaceId),
      }),
      staleTime: 60_000,
    })),
    combine: identitiesById,
  });
}
