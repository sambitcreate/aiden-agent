# Embedded content and transcript follow

The desktop transcript observes its own scroll position as well as wheel, keyboard, touch, and scrollbar input. A sandboxed inline visual can chain a scroll to the transcript without exposing its input events to the parent document. Upward movement totaling more than one pixel pauses live follow even when it arrives in fractional steps inside the usual bottom re-arm band. The next content update preserves that position. Moving back down near the end resumes follow.

Content-height clamps and viewport-size changes reset the movement baseline. A smooth jump keeps its programmatic positioning guard, and holding the scrollbar keeps the existing drag and release behavior.

On 2026-10-21, the mounted ScrollArea test reproduced a 1.5px scroll-only movement that the next streaming layout undid before the fix. The same scenario now pauses follow and preserves the offset. Tests also cover a shrinking visual, smooth jump settlement, nested scrollers, keyboard reading, scrollbar holds, and follow re-arming. The fixture contains a sandboxed iframe and drives the host scroll event stream; it does not inject a physical wheel gesture into the frame. Native iOS and Android use their own scroll policies and are unchanged.
