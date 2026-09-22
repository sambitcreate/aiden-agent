import * as React from "react";
import { chatsApi } from "./ipc";
import { htmlArtifactThemeTokensFromDocument } from "./html-artifact-preview";

/** Retain one frame only after main reauthorizes the requested revision. */
export function useDesignPreview(chatId: string, mediaId: string, artifactId: string, liveAuthority?: string) {
  const key = JSON.stringify([chatId, mediaId, artifactId, liveAuthority]);
  const [preview, setPreview] = React.useState<{
    key: string; chatId: string; src: string; contentHash?: string; designCapability?: string;
  }>();
  const [failure, setFailure] = React.useState<{ key: string; message: string }>();
  React.useEffect(() => {
    let cancelled = false;
    // Coalesce rapid History scrubbing without retaining a cache of guest documents.
    const timer = setTimeout(() => {
      void chatsApi.htmlArtifactSrcdoc(chatId, mediaId, htmlArtifactThemeTokensFromDocument(), true, liveAuthority)
        .then((result) => {
          if (cancelled) return;
          if (!result?.src) throw new Error("This design version is no longer available.");
          setPreview((current) => current?.chatId === chatId && result.contentHash &&
            current.contentHash === result.contentHash
            ? { ...current, key }
            : { ...result, key, chatId });
          setFailure(undefined);
        }).catch((cause: unknown) => {
          if (!cancelled) {
            setPreview(undefined);
            setFailure({ key, message: cause instanceof Error ? cause.message : "Could not load this design." });
          }
        });
    }, 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [chatId, mediaId, artifactId, liveAuthority, key]);
  return {
    preview: preview?.chatId === chatId ? preview : undefined,
    ready: preview?.key === key,
    error: failure?.key === key ? failure.message : undefined,
  };
}
