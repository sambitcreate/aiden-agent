// Mounts the window side of Aiden Live moving through Aiden: registers the
// renderer tool main uses for admission, take-over, OKs and notes, listens for
// the user's own keyboard and mouse input, and draws the Live outline around
// the window while Live acts. The ribbon (not this layer) shows what Live is
// doing and its Take over button.

import * as React from "react";
import { liveActivity } from "../../lib/live-activity";
import { LiveAppControlController, isLiveConfirmAnswerTarget } from "../../lib/live-app-control";
import { liveSessionBus } from "../../lib/live-session-bus";
import { useSettings } from "../../lib/queries";
import { aidenLivePreferences } from "../../shared/aiden-live-settings";
import { LIVE_APP_CONTROL_RENDERER_TOOL } from "../../shared/live-app-control";

const INPUT_EVENTS = ["keydown", "pointerdown", "wheel", "touchstart"] as const;

export function LiveAppControlLayer(): React.ReactElement | null {
  const [controller] = React.useState(
    () => new LiveAppControlController({ bus: liveSessionBus, activity: liveActivity }),
  );
  React.useEffect(() => {
    const unregister = liveSessionBus.registerTool(LIVE_APP_CONTROL_RENDERER_TOOL, controller.handle);
    const stopSession = liveSessionBus.onSession((sessionId) => {
      if (!sessionId) controller.reset();
    });
    const onInput = (event: Event) =>
      controller.userInput({
        type: event.type,
        isTrusted: event.isTrusted,
        key: event instanceof KeyboardEvent ? event.key : undefined,
        answersConfirmation: isLiveConfirmAnswerTarget(event.target),
      });
    for (const name of INPUT_EVENTS) window.addEventListener(name, onInput, { capture: true, passive: true });
    return () => {
      for (const name of INPUT_EVENTS) window.removeEventListener(name, onInput, { capture: true });
      stopSession();
      unregister();
      controller.dispose();
    };
  }, [controller]);
  const state = React.useSyncExternalStore(controller.subscribe, controller.get, controller.get);
  const colors = aidenLivePreferences(useSettings().data).ribbonColors;
  if (!state.acting) return null;
  return <LiveOutline colors={colors} />;
}

/** A soft glow around the window edges while Live acts. Purely visual. */
export function LiveOutline({ colors }: { colors: "spectrum" | "accent" }): React.ReactElement {
  return (
    <div aria-hidden="true" data-live-outline={colors} className="live-outline">
      <div className="live-outline-glow" />
    </div>
  );
}
