# Option A M2: file splits

Evidence for Task 7 (`AidenChatFeature.swift`, `b9f48f22b..1c6c3f606`) and Task 8 (`AidenWorkspaceShellView.swift`, `1c6c3f606..` the commit that adds this note). Code moved verbatim, with no behavior or visual change. Compare with `option-a-baseline.md` and `option-a-m1-floor.md`.

## Results

| Run | Scope | Passed | Skipped | Failed |
| --- | --- | --- | --- | --- |
| iOS 27.0, iPhone 18 Pro (Xcode 27.1), after Task 7 | full run | 1,342 | 7 | 0 |
| iOS 27.0, iPhone 18 Pro (Xcode 27.1), after Task 8 | full run | 1,342 | 7 | 0 |

Each full run is `AidenOnTheGoTests` 1,339 passed and 7 skipped, plus `AidenOnTheGoUITests` 3 passed, the same as Task 6. `AidenInboxTests` (20) and `AidenProductShellTests` (14) kept their baseline counts after the Task 8 moves. `npm run test:ios-release` passed 31 of 31 after each task. `ios/scripts/check-swift-file-sizes` is warning-only and exits 0.

## New files, Task 8

`AidenWorkspaceShellView.swift` stays in `Features/Remote/` (2,092 lines, down from 5,033) until Task 35 deletes it. These 12 files are in `Features/Workspace/`:

| File | Lines | Holds |
| --- | --- | --- |
| `AidenHomeModel.swift` | 782 | `AidenHomeModel`, `AidenHomeLoadPlan`, `AidenReadPresentation`, the two home list presentation functions, `aidenLoadHomeSegment` |
| `AidenWorkspaceArchiveStore.swift` | 95 | `AidenWorkspaceArchiveStore` |
| `AidenUsageView.swift` | 494 | `AidenUsagePendingView`, `AidenUsageView`, `AidenUsageHeatmapDay`, `AidenUsagePresentation`, the usage card style |
| `AidenAppSettingsView.swift` | 197 | `AidenAppSettingsView` |
| `AidenMacTranscriptionSettingsView.swift` | 114 | `AidenMacTranscriptionSettingsView` |
| `AidenInstallationsView.swift` | 197 | `AidenInstallationPresentation`, `AidenInstallationsView` (the view was deleted in the final review's fix, I4; what's left of the presentation is in `AidenMachinesView.swift`) |
| `AidenWorkspaceDirectoryView.swift` | 459 | the directory, archived list, interactive row, directory detail and workspace row |
| `AidenWorkspaceDetailView.swift` | 64 | `AidenWorkspaceDetailView` |
| `AidenWorkspaceSettingsView.swift` | 162 | `AidenWorkspaceSettingsView` |
| `AidenFolderBrowserView.swift` | 218 | `AidenFolderLocation`, `AidenFolderBrowserView`, `AidenFolderPageView` |
| `AidenNewAgentPopover.swift` | 122 | `AidenNewAgentChoice`, `AidenNewAgentPopover` |
| `AidenChatRowStatusView.swift` | 49 | `AidenChatRowStatusView` |

`AidenHomeModel` is internal in its own file, ready for Task 22. Only 11 types lost `private`: `AidenWorkspaceDefaultApplication`, `AidenAppSettingsView`, `AidenFolderBrowserView`, `AidenMacTranscriptionSettingsView`, `AidenNewAgentPopover`, `AidenUsagePendingView`, `AidenUsageView`, `AidenWorkspaceDetailView`, `AidenWorkspacesDirectoryView`, `AidenWorkspaceRow`, `AidenWorkspaceSettingsView`. No member changed access.

## Verbatim check

Comparing the original `AidenWorkspaceShellView.swift` with the union of the shell and the 12 new files, as sets of non-blank, non-import lines with access modifiers removed: 4,699 lines on each side, none in one and not the other. The only raw differences are the 11 `private struct` lines above.

## Not verified

The Xcode 26.6 compile (iOS 26.5 SDK, the CI version) has not been run, as in `option-a-m1-floor.md`. The code compiled with Xcode 27.1 only.
