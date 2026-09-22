# Dictation capture and delivery

Status: Complete.

Aiden's global dictation path now flushes trailing audio, exposes the shortcut and Accessibility paste grant for every voice provider, restores the clipboard only after a quiet post-paste window, supports hold-to-talk with press debounce, isolates on-device recognition off Electron main, and offers optional silence-stop, transcript cleanup, and pill sounds.

Settings keys: `dictationHoldToTalk`, `dictationSilenceStop`, `dictationCleanup`, `dictationSounds`. All default off.
