# Android UI tests: press Back on a sheet through its dispatcher

- Symptom: `AidenChatProgressUiTest.nestedAgentBackRestoresParentThenRosterAfterRecreation` and
  `chatInspectorOwnerRestoresAfterDelayedNegotiationAndRosterHydration` failed together with Espresso
  `RootViewWithoutFocusException`. This happened on CI's headless API 36 x86_64 emulator, on `main` and
  on unrelated PRs (for example jobs 113966793091 and 113993862648). The picked root was a `type=2`
  dialog with `has-window-focus=false`. The tests passed locally, including the full 129-test suite.
- Root cause: the tests pressed Back by injecting a key event through Espresso. Espresso picks a
  matching root once and then waits up to 10 s for that window to hold input focus. Right after
  `StateRestorationTester.emulateSavedInstanceStateRestore()`, the Material3 `ModalBottomSheet`
  dialog is disposed and recreated in place. On the slow emulator the picked dialog root did not gain
  focus within 10 s. The first fix (1ce509fa, `inRoot(isDialog())`) only changed which root was
  picked, so it still depended on window focus. A scratch probe confirmed the mechanism. With a
  focusable dialog that cannot take focus as the newest window, the old helper threw the identical
  exception and the new helper passed.
- Fix (2026-10-09): `pressBackInSheet()` finds the single Compose root whose view-tree
  `OnBackPressedDispatcherOwner` is a `ComponentDialog` (the live sheet), via
  `onAllNodes(isRoot())` and `ViewRootForTest.view`. It then calls `onBackPressedDispatcher.onBackPressed()`
  on the UI thread. This is the production path: the manifest sets `enableOnBackInvokedCallback="true"`,
  so system Back reaches the sheet's dispatcher. Both the detail `BackHandler` and Material's dismiss
  callback (`ModalBottomSheetDialogWrapper.PredictiveBackOnBackPressedCallback`) are registered there.
- For new tests that press Back inside a dialog or sheet, use the dispatcher. Do not use
  Espresso `pressBack()` with a root matcher, and do not raise Espresso's root-focus wait.
