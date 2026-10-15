import { skipToken, useQuery } from "@tanstack/react-query";
import * as React from "react";
import type { PeerHostStatus, PeerHostView } from "../../shared/peer-host";
import { hostQueryKeys } from "./host-query-keys";
import { newChatMachines, type NewChatMachine } from "./new-chat-targets";

/**
 * Paired hosts a new chat could run on, from the host queries the sidebar
 * keeps current. Reading them never starts supervision or contacts a host.
 */
export function useNewChatMachines(): NewChatMachine[] {
  const list = useQuery<PeerHostView[]>({ queryKey: hostQueryKeys.list(), queryFn: skipToken });
  const statuses = useQuery<PeerHostStatus[]>({ queryKey: hostQueryKeys.statuses(), queryFn: skipToken });
  return React.useMemo(() => newChatMachines(list.data ?? [], statuses.data ?? []), [list.data, statuses.data]);
}
