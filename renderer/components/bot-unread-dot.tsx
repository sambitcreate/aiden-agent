/** A Bot row's unread dot, inline after the name: it takes room only when it is there. */
export function BotUnreadDot() {
  return (
    <span
      role="img"
      aria-label="Unread"
      title="New reply"
      className="inline-flex size-2 shrink-0 rounded-full bg-accent"
    />
  );
}
