# Option A M7: copy and tokens

Evidence for Task 33, "Copy and the rest of the app". Base `5daa370f7` on `ios/option-a-lane-text`. The spec's decision 9 says to keep the word "machines" in new UI and to replace "Mac" where a Linux or CLI host could be meant. Aiden Agent ships for macOS and Linux (`README.md`), and `aiden serve` hosts run without the desktop app, so "Mac" stays only where the feature exists on macOS alone.

## How the list was made

Every line under `ios/AidenOnTheGo` and `ios/AidenLiveActivityWidget` with `Mac` or `Macs` as a whole word inside a string literal, plus `Info.plist`. At `5daa370f7` that was 123 lines in 35 Swift files, plus 2 `Info.plist` entries. The plan's "55 files, about 106 lines" was measured at `a6836c507`. Earlier tasks moved or rewrote some of that copy. Comment lines that only say "the Mac" about the host are not copy and were left alone, except where a comment quotes a string that changed.

Rules applied:

- **Change** "your Mac" to "your machine", "this Mac" to "this machine", "the Mac" to "the machine" and "on Mac" to "on your machine". This matches the new shell's copy ("Waiting for your machine…", "Can’t reach your machine").
- **Keep** when the feature runs only on macOS: iOS Simulator sharing needs Xcode, and Computer Use is gated to `darwin` (`main/services/computer-use/platform.ts`).
- **Keep** text the host sends or that is shared across clients: the Bot activity phase table is pinned to `protocol/aiden-remote/v1/fixtures/contract.json`, which desktop, Android and iOS all draw from. Changing one client would break the contract test (`testThePhaseTableIsTheOneTheMacDraws`).
- **Keep** demo data: "Studio Mac" is the name of a demo machine, and a real Mac can be called that.
- **Keep** the old shell's coachmark copy. Task 35 deletes the coachmark, and no test pins it in both shells.

## Changed (94)

| Where (after the change) | Before | After | Decision |
| --- | --- | --- | --- |
| `Networking/AidenRemoteClient.swift:636` | Your new chat was started on your Mac but | Your new chat was started on your machine but | Change: any paired host |
| `Networking/AidenRemoteClient.swift:4220` | Voice and credentials are managed on your Mac. Selected response text is sent from your Mac to Google | Voice and credentials are managed on your machine. Selected response text is sent from your machine to Google | Change: any paired host |
| `Features/Bots/AidenBotSettingsDraft.swift:274` | no model that reads images is set up on your Mac. | no model that reads images is set up on your machine. | Change: any paired host |
| `Features/Bots/AidenBotCreateView.swift:116` | Aiden couldn’t reach your Mac, so the Bot wasn’t made. Try again. | Aiden couldn’t reach your machine, so the Bot wasn’t made. Try again. | Change: any paired host |
| `Features/Bots/AidenBotCreateView.swift:118` | so it wasn’t sent to your Mac. Try again. | so it wasn’t sent to your machine. Try again. | Change: any paired host |
| `Features/Bots/AidenBotCreateView.swift:776` | It needs an AI model before it can reply. Choose one on your Mac. | It needs an AI model before it can reply. Choose one on your machine. | Change: any paired host |
| `Features/Bots/AidenBotCreateView.swift:778` | It can use everything your Mac allows. You can change this later in Advanced. | It can use everything your machine allows. You can change this later in Advanced. | Change: any paired host |
| `Features/Bots/AidenBotSessionChatView.swift:1332` | Aiden couldn’t reach your Mac. Try again. | Aiden couldn’t reach your machine. Try again. | Change: any paired host |
| `Features/Bots/AidenBotSessionChatView.swift:1567` | Open on your Mac | Open on your machine | Comment: quotes or describes changed copy |
| `Features/Bots/AidenBotRoutinesView.swift:380` | This routine changed on your Mac. Review it and try again. | This routine changed on your machine. Review it and try again. | Change: any paired host |
| `Features/Bots/AidenBotRoutinesView.swift:381` | This routine was removed on your Mac. | This routine was removed on your machine. | Change: any paired host |
| `Features/Bots/AidenBotAdvancedView.swift:5` | Aiden couldn’t reach your Mac, so Advanced wasn’t saved. | Aiden couldn’t reach your machine, so Advanced wasn’t saved. | Change: any paired host |
| `Features/Bots/AidenBotAdvancedView.swift:6` | Something changed on your Mac, so Advanced wasn’t saved. | Something changed on your machine, so Advanced wasn’t saved. | Change: any paired host |
| `Features/Bots/AidenBotAdvancedView.swift:298` | add an AI that can see images on your Mac. | add an AI that can see images on your machine. | Change: any paired host |
| `Features/Bots/AidenBotAdvancedView.swift:329` | It can use everything your Mac allows. Your Mac still asks before risky steps. | It can use everything your machine allows. Your machine still asks before risky steps. | Change: any paired host |
| `Features/Bots/AidenBotAdvancedView.swift:361` | What you see in its chat on your Mac while it works. | What you see in its chat on your machine while it works. | Change: any paired host |
| `Features/Bots/AidenBotAdvancedView.swift:533` | Connect to your Mac to change this. | Connect to your machine to change this. | Change: any paired host |
| `Features/Bots/AidenBotAdvancedView.swift:685` | Needs an AI model. Set one up on your Mac, then try again. | Needs an AI model. Set one up on your machine, then try again. | Change: any paired host |
| `Features/Bots/AidenBotAdvancedView.swift:808` | Set up on your Mac | Set up on your machine | Change: any paired host |
| `Features/Bots/AidenBotAdvancedView.swift:881` | This changed on your Mac. Showing what it has now. | This changed on your machine. Showing what it has now. | Change: any paired host |
| `Features/Bots/AidenBotAdvancedView.swift:882` | Aiden couldn’t reach your Mac to save that choice. | Aiden couldn’t reach your machine to save that choice. | Change: any paired host |
| `Features/Bots/AidenBotAdvancedView.swift:929` | chat on your Mac while it works. Changes save as you pick them. | chat on your machine while it works. Changes save as you pick them. | Change: any paired host |
| `Features/Bots/AidenBotsHomeView.swift:736` | Connect to your Mac to see your Bots. | Connect to your machine to see your Bots. | Change: any paired host |
| `Features/Chat/AidenChatViewModel+Fork.swift:95` | This chat changed on your Mac. Try again. | This chat changed on your machine. Try again. | Change: any paired host |
| `Features/Bots/AidenBotMemoryView.swift:25` | It’s stored on this Mac, and | It’s stored on this machine, and | Change: any paired host |
| `Features/Bots/AidenBotProfileView.swift:319` | Connect to your Mac, then try again. | Connect to your machine, then try again. | Change: any paired host |
| `Features/Chat/AidenChatViewModel.swift:1205` | This device can no longer stop agents on this Mac. | This device can no longer stop agents on this machine. | Change: any paired host |
| `Features/Chat/AidenChatViewModel.swift:2777` | Refreshing the current request from your Mac. | Refreshing the current request from your machine. | Change: any paired host |
| `Features/Chat/AidenChatViewModel.swift:2840` | Refreshing the current prompt from your Mac. | Refreshing the current prompt from your machine. | Change: any paired host |
| `Features/Chat/AidenChatViewModel.swift:925` | Tell the paired Mac which displayed message | Tell the paired machine which displayed message | Comment: quotes or describes changed copy |
| `Features/Chat/AidenAttachmentPicker.swift:728` | Reconnect to your Mac to use this attachment option | Reconnect to your machine to use this attachment option | Change: any paired host |
| `Features/Bots/AidenBotSessionModel.swift:252` | Set up on your Mac | Set up on your machine | Change: any paired host |
| `Features/Bots/AidenBotSessionModel.swift:262` | Finish on your Mac | Finish on your machine | Change: any paired host |
| `Features/Bots/AidenBotSessionModel.swift:263` | Finish this on your Mac. | Finish this on your machine. | Change: any paired host |
| `Features/Bots/AidenBotSessionModel.swift:264` | Check your Mac to finish. | Check your machine to finish. | Change: any paired host |
| `Features/Bots/AidenBotSessionModel.swift:277` | Finish signing in on your Mac, or skip it. | Finish signing in on your machine, or skip it. | Change: any paired host |
| `Features/Bots/AidenBotSessionModel.swift:285` | Finish signing in on your Mac. | Finish signing in on your machine. | Change: any paired host |
| `Features/Bots/AidenBotSessionModel.swift:286` | Open Aiden on your Mac to finish signing in. | Open Aiden on your machine to finish signing in. | Change: any paired host |
| `Features/Bots/AidenBotSessionModel.swift:288` | Finish this step on your Mac. | Finish this step on your machine. | Change: any paired host |
| `Features/Bots/AidenBotSessionModel.swift:289` | Open Aiden on your Mac to finish this step. | Open Aiden on your machine to finish this step. | Change: any paired host |
| `Features/Bots/AidenBotSessionModel.swift:290` | This step is on the Bot’s own screen on your Mac. | This step is on the Bot’s own screen on your machine. | Change: any paired host |
| `Features/Bots/AidenBotSessionModel.swift:300` | Open on your Mac | Open on your machine | Change: any paired host |
| `Features/Bots/AidenBotSessionModel.swift:306` | That didn’t reach your Mac. Please try again. | That didn’t reach your machine. Please try again. | Change: any paired host |
| `Features/Bots/AidenBotSessionModel.swift:313` | That didn’t reach your Mac. Please try again. | That didn’t reach your machine. Please try again. | Change: any paired host |
| `Features/Bots/AidenBotSessionModel.swift:1037` | Your Mac didn’t answer in time. | Your machine didn’t answer in time. | Change: any paired host |
| `Features/Bots/AidenBotSessionModel.swift:3080` | Your Mac didn’t get that request. Please try again. | Your machine didn’t get that request. Please try again. | Change: any paired host |
| `Features/Chat/AidenChatPolicies.swift:472` | which runs only on your Mac. Replies from here use | which runs only on your machine. Replies from here use | Change: any paired host |
| `Features/Chat/AidenChatPolicies.swift:474` | which runs only on your Mac. Choose a model for replies from here. | which runs only on your machine. Choose a model for replies from here. | Change: any paired host |
| `Features/Chat/AidenChatViewModel+ForeignRuns.swift:604` | Answer it on your Mac. | Answer it on your machine. | Change: any paired host |
| `Features/Chat/AidenChatViewModel+ForeignRuns.swift:639` | Check the request on your Mac. | Check the request on your machine. | Change: any paired host |
| `Features/Chat/AidenChatViewModel+ForeignRuns.swift:675` | Check the prompt on your Mac. | Check the prompt on your machine. | Change: any paired host |
| `Features/Chat/AidenChatViewModel+ForeignRuns.swift:680` | Answered on Mac | Answered on your machine | Comment: quotes or describes changed copy |
| `Features/Chat/AidenChatCards.swift:693` | Sends your answers to your Mac | Sends your answers to your machine | Change: any paired host |
| `Features/Workspace/AidenAppSettingsView.swift:121` | Manage model connections on your paired Mac. | Manage model connections on your paired machine. | Change: any paired host |
| `Features/Workspace/AidenAppSettingsView.swift:138` | This controls memory on your paired Mac. | This controls memory on your paired machine. | Change: any paired host |
| `Features/Workspace/AidenAppSettingsView.swift:142` | Set up on your Mac | Set up on your machine | Change: any paired host |
| `Features/Workspace/AidenAppSettingsView.swift:167` | processed on-device by your paired Mac, and not retained. | processed on-device by your paired machine, and not retained. | Change: any paired host |
| `Features/Workspace/AidenWorkspaceSettingsView.swift:75` | Existing memory stays on your Mac. | Existing memory stays on your machine. | Change: any paired host |
| `Features/Workspace/AidenHomeModel.swift:134` | Couldn’t mark that chat read. Try again once your Mac is reachable. | Couldn’t mark that chat read. Try again once your machine is reachable. | Change: any paired host |
| `Features/Workspace/AidenUsageView.swift:14` | Usage appears once your Mac is reachable. | Usage appears once your machine is reachable. | Change: any paired host |
| `Features/Workspace/AidenUsageView.swift:15` | Your Mac didn't return usage this time. | Your machine didn't return usage this time. | Change: any paired host |
| `Features/Remote/AidenProvidersView.swift:27` | Connected to your Mac | Connected to your machine | Change: any paired host |
| `Features/Remote/AidenProvidersView.swift:28` | Providers and API keys are stored on your paired Mac. | Providers and API keys are stored on your paired machine. | Change: any paired host |
| `Features/Remote/AidenProvidersView.swift:33` | Connect to an updated Mac with permission to manage workspaces to add providers. | Connect to an updated machine with permission to manage workspaces to add providers. | Change: any paired host |
| `Features/Remote/AidenProvidersView.swift:46` | Connect to your paired Mac. | Connect to your paired machine. | Change: any paired host |
| `Features/Remote/AidenProvidersView.swift:97` | Local to the Mac | Local to the machine | Change: any paired host |
| `Features/Remote/AidenWorkspaceShellView.swift:523` | Can’t Reach Your Mac | Can’t reach your machine | Change: any paired host |
| `Features/Remote/AidenWorkspaceShellView.swift:559` | Waiting for your Mac… | Waiting for your machine… | Change: any paired host |
| `Features/Remote/AidenWorkspaceShellView.swift:580` | Your Mac isn’t reachable right now. Try again once it’s connected. | Your machine isn’t reachable right now. Try again once it’s connected. | Change: any paired host |
| `Features/Remote/AidenVisualDocument.swift:132` | Can't reach your Mac. Check the connection and try again. | Can't reach your machine. Check the connection and try again. | Change: any paired host |
| `Features/Remote/AidenVisualDocument.swift:136` | This visual is no longer available on your Mac. | This visual is no longer available on your machine. | Change: any paired host |
| `Features/Remote/AidenSpendingNotice.swift:44` | or change the limit on your Mac. | or change the limit on your machine. | Change: any paired host |
| `Features/Remote/AidenBotChatToolsView.swift:336` | This file changed on your Mac. Reload it before saving again. | This file changed on your machine. Reload it before saving again. | Change: any paired host |
| `Features/Remote/AidenBotChatToolsView.swift:338` | Something changed on your Mac. Go back to the chat and open Files again. | Something changed on your machine. Go back to the chat and open Files again. | Change: any paired host |
| `Features/Remote/AidenBotChatToolsView.swift:531` | Reload from Mac | Reload from machine | Change: any paired host |
| `Features/Remote/AidenNewWorktree.swift:10` | in its own worktree on your Mac. | in its own worktree on your machine. | Change: any paired host |
| `Features/Remote/AidenVisualViewer.swift:131` | May be out of date. Your Mac couldn't be reached. | May be out of date. Your machine couldn't be reached. | Change: any paired host |
| `Models/AidenChat.swift:834` | Watch this recording on your Mac. | Watch this recording on your machine. | Change: any paired host |
| `Models/AidenChat.swift:835` | This recording is no longer on the Mac. | This recording is no longer on the machine. | Change: any paired host |
| `Models/AidenChat.swift:3439` | Allow this on your Mac. You can deny it here. | Allow this on your machine. You can deny it here. | Change: any paired host |
| `Models/AidenChat.swift:3939` | Answered on Mac: allowed | Answered on your machine: allowed | Change: any paired host |
| `Models/AidenChat.swift:3941` | Answered on Mac: denied | Answered on your machine: denied | Change: any paired host |
| `Models/AidenChat.swift:3943` | Question expired on Mac | Question expired on your machine | Change: any paired host |
| `Models/AidenChat.swift:3945` | Answered on Mac | Answered on your machine | Change: any paired host |
| `Features/Remote/AidenBackgroundJobs.swift:34` |  on your Mac |  on your machine | Change: any paired host |
| `Features/Remote/AidenBackgroundJobs.swift:147` | These run on your Mac. Open an address in a browser there. | These run on your machine. Open an address in a browser there. | Change: any paired host |
| `Models/AidenChatProgress.swift:460` | The Mac could not read a valid task snapshot. | The machine could not read a valid task snapshot. | Change: any paired host |
| `Models/AidenChatProgress.swift:488` | Live status from the Mac. You can stop a running agent; private child transcripts stay on the Mac. | Live status from the machine. You can stop a running agent; private child transcripts stay on the machine. | Change: any paired host |
| `Models/AidenChatProgress.swift:489` | Read-only status from the Mac. Private child transcripts stay on the Mac. | Read-only status from the machine. Private child transcripts stay on the machine. | Change: any paired host |
| `Models/AidenChatProgress.swift:724` | Asks the Mac to stop this delegated agent. The rest of the run continues. | Asks the machine to stop this delegated agent. The rest of the run continues. | Change: any paired host |
| `Models/AidenChatProgress.swift:726` | The Mac stops only this agent. The main run and other agents keep going. | The machine stops only this agent. The main run and other agents keep going. | Change: any paired host |
| `Models/AidenChatProgress.swift:779` | The Mac stops this delegated agent. You cannot resume it from here. | The machine stops this delegated agent. You cannot resume it from here. | Change: any paired host |
| `Resources/Info.plist:55` | transcribed on this device or securely by your paired Mac. | transcribed on this device or securely by your paired machine. | Change: any paired host |
| `Resources/Info.plist:59` | choose images to send to your paired Mac. | choose images to send to your paired machine. | Change: any paired host |

The 94 rows are 89 copy strings, 2 `Info.plist` permission prompts, and 3 comments that quote changed copy. The 123 matched Swift lines split as: 91 lines of copy changed (89 rows, because the two "Refreshing the current request/prompt" rows each cover two identical lines in `AidenChatViewModel.swift`), 2 comments changed, 18 kept below, and 12 code comments about the host left alone. The third changed comment, `AidenChatViewModel.swift:925`, has no quotes, so the search did not match it.

## Kept (18)

| Where | String | Decision |
| --- | --- | --- |
| `Features/Bots/AidenBotSessionModel.swift:338` | Using your Mac | Keep: Computer Use runs only on macOS. Also pinned by the shared phase table. |
| `Features/Bots/AidenBotSessionModel.swift:347` | Reconnecting to your Mac | Keep for now: pinned by the shared phase table in `contract.json`, `renderer/shared/bot-activity.ts:70` and Android `bot_activity_reconnecting`. Changing it is a cross-client contract change. See follow-ups. |
| `Features/Simulators/AidenSimulatorViewerModel.swift:166` | Turn on Share with Aiden On The Go in Aiden on your Mac (Settings → Simulator). | Keep: iOS Simulator needs Xcode on macOS |
| `Features/Simulators/AidenSimulatorViewerModel.swift:168` | This iPhone can’t control simulators on this Mac. | Keep: simulators |
| `Features/Simulators/AidenSimulatorViewerModel.swift:170` | Open on your Mac to view | Keep: simulators |
| `Features/Simulators/AidenSimulatorViewer.swift:136` | The simulator closes on your Mac. | Keep: simulators |
| `Features/Simulators/AidenSimulatorViewer.swift:185` | Your Mac didn’t report its device tool versions. | Keep: simulators |
| `Features/Simulators/AidenSimulatorViewer.swift:187` | Device tools update with Aiden on your Mac. | Keep: simulators |
| `Features/Simulators/AidenSimulatorViewer.swift:336` | On your Mac (device section) | Keep: simulators |
| `Features/Remote/AidenProductShellView.swift:251` | …allow it on your Mac. (coachmark detail) | Keep: old-shell coachmark, deleted in Task 35 |
| `Features/Remote/Demo/AidenDemoHosts.swift:411, 418, 429, 431, 441` | Studio Mac | Keep: demo machine name (5 lines, counted as 5) |
| `Features/Remote/Demo/AidenDemoHosts.swift:862` | Can use your Mac, shell, enabled connections, and skills. | Keep: stands in for text the host sends |
| `Features/Remote/Demo/AidenDemoHosts.swift:896` | The Mac does not serve that path. | Keep: stands in for a host error message |
| `Models/AidenBotSession.swift:988` | your whole Mac | Keep: compared with the label the host sends for whole-computer folder access, not shown by this line |

## Other copy on the screens that took tokens

Sentence case on the three screens Task 33 tokenised. "Read Aloud" stays as the desktop feature's name.

| Where | Before | After |
| --- | --- | --- |
| `Features/Workspace/AidenAppSettingsView.swift` | App Settings (title), Global Defaults, Voice Input, Privacy Policy | App settings, Global defaults, Voice input, Privacy policy |
| `Features/Conversation/AidenComposerSession.swift:57` | …speech model in App Settings… | …speech model in App settings… (names the page) |
| `Features/Workspace/AidenUsageView.swift` | Usage Unavailable, Usage Couldn't Load, Try Again, Your Activity | Usage unavailable, Usage couldn't load, Try again, Your activity |
| `Features/Remote/AidenScheduledTasksView.swift` | Scheduled Tasks (title and alert), Schedule Access Required (2), No Scheduled Tasks, Create Manually, Run Now (2), Run History, Task Removed, Connector List Required, Refresh Scheduled Tasks…, Preview Next Runs, Unattended Access, Schedule Write Access Required (3), New Task, Edit Task, Final Review, Review Task, Task Settings | Same words in sentence case |

`Paired Installations` in Settings is left as it is. It shows only with the flag off, and `AidenMachineDetailTests` pins it there.

## Pinned test strings updated

`AidenBotHomeProfileTests`, `AidenBotSessionTests`, `AidenChatTests`, `AidenSpendingTests`, `AidenRemotePhase0Tests`, `AidenRemoteClientTests`, and `AidenShellUITests` (the "App settings" and "Scheduled tasks" navigation bars). Host JSON fixtures in `AidenChatTests` that carry "This recording is no longer on the Mac." are host text and stay. `scripts/check-ios-shipping-target.test.mjs` only asserts that iOS never says "approved on your Mac", which still holds. It needed no change.

## Tokens and glass

Settings, Scheduled Tasks and Usage now take spacing and radius from `AidenSpacing` and `AidenRadius`, and status text colours from the palette.

- Spacing off the 4-8-12-16-20-24-32 scale moved to the nearest step, and a tie went to the smaller one, so no layout grows: 2, 3, 5 and 6 became 4; 10 became 8; 14 became 12; 18 became 16; 28 became 24; 36 became 32. `.padding()` became `AidenSpacing.l`.
- Usage cards and the privacy note use `AidenRadius.card` (the note was 18). Icon tiles and loading rows use `AidenRadius.code` (they were 9 and 10). Loading blocks that stand for cards use `AidenRadius.card` (they were 14).
- The heatmap cells (radius 5) and legend swatches (radius 3) are chart marks, not controls or cards, so they keep their radii.
- Red error text became `palette.dangerText`: the memory error in Settings, a run's error code, and the editor's validation message. The Pause swipe action uses `palette.warning`, not `.orange`.
- None of the three screens puts glass on content. The offline banner over Scheduled Tasks is a material, not glass, and stays.

`AidenPalette` now works out `successTextHex`, `warningTextHex` and `dangerTextHex` once, when it is made. `applyingContrast` copies them, because contrast only moves the secondary text. Rows read stored values.

## Results

| Run | Scope | Passed | Skipped | Failed |
| --- | --- | --- | --- | --- |
| iOS 27.0, Aiden Lane text sim (Xcode 27.1), at `b074d94b7` | full run, unit | 2,212 | 7 | 2 |
| same | full run, UI | 45 | 2 | 0 |
| iOS 27.0, Aiden Lane text sim, at `32844f546` | unit bundle rerun | 2,214 | 7 | 0 |

The two unit failures at `b074d94b7` were pinned strings this task changed, not app faults: `testPhotoLibraryUsageDescriptionCoversPickerAndSaveActions` looked for "paired Mac" in the photo permission prompt, and `AidenBackgroundJobsTests.testTheWordsMatchTheMac` pinned "on your Mac" after job addresses. `32844f546` updates both, and the unit bundle was run again. `npm run test:ios-release`, which includes `scripts/check-ios-shipping-target.test.mjs`, passed 32 of 32.

New tests, each seen failing first (`task-33-red.log`):

- `AidenChatDockTests.testALongQuestionKeepsSkipAndSubmitInsideTheCard`: Skip and Submit were 836 points down a card that ends at 423.
- `AidenDesignTokenTests.testStatusTextIsResolvedWhenThePaletteIsMadeNotOnEachRead`: 150 reads made 150 resolves.
- `AidenUnifiedInboxTests.testASearchDropsAMachineWithNoMatchUnderAll`: a machine with no match stayed in the list under All.
- `AidenNewWorkTargetTests.testThePickerNamesMachinesAsTheInboxDoes`: two machines both read "Studio" in the picker.
