import { act } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import type { Workspace } from "./types";

export const TEST_WORKSPACE: Workspace = {
  id: "ws-1",
  name: "app",
  folderPath: "/tmp/app",
  permission: "full",
  createdAt: 1,
  updatedAt: 1,
};

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  });
}

export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
