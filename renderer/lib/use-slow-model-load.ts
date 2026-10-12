// Shared by the dictation pill and the composer mic: tracks on-device model
// lifecycle events and shows "Loading model…" when a load outlasts the grace
// period while a transcription waits for it.

import * as React from "react";
import type { LocalSpeechState } from "../shared/local-speech-state";
import { voiceApi } from "./ipc-voice";
import { SlowModelLoadNotice } from "./slow-model-load";

export function useSlowModelLoad() {
  const [loadingModel, setLoadingModel] = React.useState(false);
  // Latest state per model: the warm-up may start loading before capture ends.
  const statesRef = React.useRef(new Map<string, LocalSpeechState["state"]>());
  const watchRef = React.useRef<{ modelId: string; notice: SlowModelLoadNotice } | null>(null);

  React.useEffect(() => {
    const unsubscribe = voiceApi.onState((event) => {
      statesRef.current.set(event.modelId, event.state);
      const watch = watchRef.current;
      if (watch && watch.modelId === event.modelId) watch.notice.observe(event.state);
    });
    return () => {
      unsubscribe();
      watchRef.current?.notice.dispose();
      watchRef.current = null;
    };
  }, []);

  /** Ends the given wait (or any wait when omitted) and hides the notice. */
  const end = React.useCallback((notice?: SlowModelLoadNotice) => {
    const watch = watchRef.current;
    if (!watch || (notice && watch.notice !== notice)) return;
    watchRef.current = null;
    watch.notice.dispose();
    setLoadingModel(false);
  }, []);

  /** Starts waiting for `modelId`'s transcription; returns the handle to pass to `end`. */
  const begin = React.useCallback(
    (modelId: string): SlowModelLoadNotice => {
      end();
      const notice = new SlowModelLoadNotice({
        setTimer: (callback, ms) => setTimeout(callback, ms),
        clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
        onShow: () => {
          if (watchRef.current?.notice === notice) setLoadingModel(true);
        },
      });
      watchRef.current = { modelId, notice };
      if (statesRef.current.get(modelId) === "loading") notice.observe("loading");
      return notice;
    },
    [end],
  );

  return { loadingModel, begin, end };
}
