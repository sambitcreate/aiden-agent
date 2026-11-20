# Smarter artifacts and design mode: screenshots

Before/after images for the `feat/smarter-artifacts-design-mode` PR. Before is `origin/main` (acca96c2c), after is the PR head (b8324855f). Names follow `<surface>-<state>-<theme>-{before,after}.png`; all at 2x.

- `visual-captions-*` and `visual-actions-*`: Electron E2E with the deterministic LM Studio fake, rendered in a Cua Space (Linux, xvfb).
- `design-comment-sent-*`: the real `CommentBox` rendered in headless Chromium with the app stylesheet.
- `serve-html-visual-phone-picture-*`: the `aiden serve` render of an HTML visual sent to phones (no before: phones previously got text).
