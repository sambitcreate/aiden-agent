import SwiftUI

// The three onboarding vignettes, drawn on AidenOnboardingArtwork's 300 × 220 pt
// canvas. Each is a simplified crop of the iOS surface its page introduces, and
// each mirrors one desktop feature-tour tile: WorkspaceAgentArt, ModelFreedomArt,
// and ScheduledAutomationsArt.

/// Bots and Workspaces: a workspace chat with an edit landing, the Aiden-logo
/// switcher menu open on Workspaces, and the file tree it works in.
struct AidenOnboardingBuildArt: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenOnboardingArtColors) private var colors
    let motion: AidenOnboardingArtMotion

    var body: some View {
        ZStack(alignment: .topLeading) {
            OnboardingArtWindow(origin: CGPoint(x: 16, y: 14), width: 184, height: 232, cornerRadius: 20, padding: 10) {
                HStack(spacing: 5) {
                    HStack(spacing: 2) {
                        Circle().fill(colors.ink).frame(width: 9, height: 9)
                        OnboardingArtSymbol(name: "chevron.down", size: 5)
                    }
                    .padding(.horizontal, 4)
                    .frame(height: 15)
                    .background(colors.fill, in: Capsule())
                    OnboardingArtBar(width: 50, tone: .ink)
                    Spacer(minLength: 0)
                    OnboardingArtSymbol(name: "ellipsis", size: 7)
                }
                .padding(.bottom, 10)

                VStack(alignment: .leading, spacing: 4) {
                    OnboardingArtBar(width: 92)
                    OnboardingArtBar(width: 58)
                }
                .padding(7)
                .background(colors.fill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .frame(maxWidth: .infinity, alignment: .trailing)

                VStack(alignment: .leading, spacing: 4) {
                    OnboardingArtBar(width: 148, reveal: motion.reveal())
                    OnboardingArtBar(width: 160, reveal: motion.reveal(delay: 0.18))
                    OnboardingArtBar(width: 104, reveal: motion.reveal(delay: 0.36))
                }
                .padding(.top, 9)

                toolRow
                    .modifier(OnboardingArtPop(reveal: motion.reveal(delay: 0.9)))
                    .padding(.top, 8)

                VStack(alignment: .leading, spacing: 4) {
                    OnboardingArtBar(width: 136, reveal: motion.reveal(delay: 1.5))
                    OnboardingArtBar(width: 76, reveal: motion.reveal(delay: 1.68))
                }
                .padding(.top, 8)

                Spacer(minLength: 0)
                composer
                    .padding(.bottom, 44)
            }

            OnboardingArtWindow(origin: CGPoint(x: 166, y: 38), width: 118, raised: true, cornerRadius: 12) {
                switcherRow(selected: false) {
                    AidenBotShapeSwatch(shape: .wisp, color: AidenBotAvatarColor.peach.swatch, size: 11)
                    OnboardingArtText("Bots", size: 8.5, style: .primary)
                }
                OnboardingArtSeparator(leadingInset: 24)
                switcherRow(selected: true) {
                    OnboardingArtSymbol(name: "folder.fill", size: 8, color: palette.accent)
                    OnboardingArtText("Workspaces", size: 8.5, weight: .semibold, style: .primary)
                }
            }
            .offset(y: motion.float)

            OnboardingArtWindow(origin: CGPoint(x: 182, y: 118), width: 104, raised: true, cornerRadius: 12, padding: 8) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 3) {
                        OnboardingArtSymbol(name: "chevron.down", size: 5)
                        OnboardingArtSymbol(name: "folder", size: 7)
                        OnboardingArtBar(width: 34, tone: .ink, height: 4)
                    }
                    HStack(spacing: 3) {
                        OnboardingArtSymbol(name: "doc.text", size: 7, color: palette.accent)
                        OnboardingArtText(verbatim: "Pairing.swift", size: 7, style: .primary, monospaced: true)
                    }
                    .padding(.leading, 11)
                    HStack(spacing: 3) {
                        OnboardingArtSymbol(name: "doc", size: 7)
                        OnboardingArtBar(width: 40, tone: .soft, height: 4)
                    }
                    .padding(.leading, 11)
                }
            }
        }
    }

    private var toolRow: some View {
        HStack(spacing: 4) {
            OnboardingArtSymbol(name: "checkmark.circle.fill", size: 8)
            OnboardingArtText("Edited", size: 7.5, weight: .semibold, style: .primary)
            OnboardingArtText(verbatim: "Pairing.swift", size: 7, monospaced: true)
            OnboardingArtText(verbatim: "+12", size: 7, weight: .semibold, style: .custom(palette.success), monospaced: true)
            OnboardingArtText(verbatim: "−3", size: 7, weight: .semibold, style: .custom(palette.danger), monospaced: true)
        }
        .padding(.horizontal, 7)
        .frame(height: 20)
        .background(colors.fill, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private var composer: some View {
        HStack(spacing: 6) {
            OnboardingArtSymbol(name: "plus", size: 9, weight: .medium)
            OnboardingArtText("Message Aiden", size: 8, style: .tertiary)
            Spacer(minLength: 0)
            OnboardingArtSymbol(name: "mic", size: 8, weight: .medium)
            OnboardingArtSendButton()
        }
        .padding(.leading, 9)
        .padding(.trailing, 5)
        .frame(height: 28)
        .background(palette.raised, in: Capsule())
        .shadow(color: colors.surfaceShadow, radius: 3, y: 1)
    }

    private func switcherRow<Content: View>(
        selected: Bool,
        @ViewBuilder content: () -> Content
    ) -> some View {
        HStack(spacing: 6) {
            content()
            Spacer(minLength: 0)
            if selected {
                OnboardingArtSymbol(name: "checkmark", size: 7, weight: .bold, color: palette.accent)
            }
        }
        .padding(.horizontal, 7)
        .frame(height: 22)
        .background(
            selected ? palette.accent.opacity(0.12) : .clear,
            in: RoundedRectangle(cornerRadius: 8, style: .continuous)
        )
    }
}

/// Choose and Extend: the composer's model menu, grouped by provider, with the
/// selected model's thinking levels open beside it and an image waiting to send.
struct AidenOnboardingExtendArt: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenOnboardingArtColors) private var colors
    let motion: AidenOnboardingArtMotion

    var body: some View {
        ZStack(alignment: .topLeading) {
            OnboardingArtWindow(origin: CGPoint(x: 16, y: 12), width: 150, raised: true, padding: 5) {
                providerHeader(id: "anthropic", label: "Anthropic", model: "claude")
                modelRow(width: 70, selected: true)
                modelRow(width: 52)
                OnboardingArtSeparator(leadingInset: 0).padding(.vertical, 3)
                providerHeader(id: "google", label: "Google")
                modelRow(width: 62)
                OnboardingArtSeparator(leadingInset: 0).padding(.vertical, 3)
                providerHeader(id: "ollama", label: "Ollama")
                modelRow(width: 46)
            }

            OnboardingArtWindow(origin: CGPoint(x: 160, y: 30), width: 118, raised: true, cornerRadius: 12) {
                thinkingRow("Low", selected: false)
                thinkingRow("Medium", selected: false)
                thinkingRow("High", selected: true)
            }
            .modifier(OnboardingArtPop(reveal: motion.reveal(delay: 0.5)))
            .offset(y: motion.float)

            attachment
                .offset(x: 232, y: 120)

            composer
                .offset(x: 16, y: 172)
        }
    }

    private var attachment: some View {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(colors.fill)
            .frame(width: 44, height: 44)
            .overlay {
                OnboardingArtSymbol(name: "photo", size: 14, weight: .regular, color: colors.ink)
            }
            .overlay(alignment: .topTrailing) {
                Image(systemName: "xmark")
                    .font(.system(size: 5, weight: .bold))
                    .foregroundStyle(palette.secondary)
                    .frame(width: 11, height: 11)
                    .background(palette.raised, in: Circle())
                    .offset(x: 3, y: -3)
            }
            .shadow(color: colors.surfaceShadow, radius: 3, y: 1)
    }

    private var composer: some View {
        HStack(spacing: 6) {
            OnboardingArtSymbol(name: "plus", size: 9, weight: .medium)
            HStack(spacing: 3) {
                AidenProviderIcon(
                    providerID: "anthropic",
                    providerLabel: "Anthropic",
                    modelID: "claude",
                    size: 9,
                    color: palette.secondary
                )
                OnboardingArtBar(width: 40, tone: .ink, height: 4)
                OnboardingArtText(verbatim: "· High", size: 7.5)
                OnboardingArtSymbol(name: "chevron.down", size: 5)
            }
            .scaleEffect(motion.press(delay: 0.2))
            Spacer(minLength: 0)
            OnboardingArtSymbol(name: "mic", size: 8, weight: .medium)
            OnboardingArtSendButton()
        }
        .padding(.leading, 10)
        .padding(.trailing, 6)
        .frame(width: 268, height: 32)
        .background(palette.raised, in: Capsule())
        .shadow(color: colors.raisedShadow, radius: 8, y: 3)
    }

    private func providerHeader(id: String, label: LocalizedStringKey, model: String? = nil) -> some View {
        HStack(spacing: 4) {
            AidenProviderIcon(
                providerID: id,
                providerLabel: id,
                modelID: model,
                size: 9,
                color: palette.secondary
            )
            OnboardingArtText(label, size: 7, weight: .semibold)
        }
        .padding(.horizontal, 6)
        .frame(height: 16)
    }

    private func modelRow(width: CGFloat, selected: Bool = false) -> some View {
        HStack(spacing: 4) {
            OnboardingArtBar(width: width, tone: selected ? .ink : .regular)
            Spacer(minLength: 0)
            OnboardingArtSymbol(
                name: "chevron.right",
                size: 6,
                color: selected ? palette.accent : palette.secondary.opacity(0.6)
            )
        }
        .padding(.horizontal, 6)
        .frame(height: 19)
        .background(
            selected ? palette.accent.opacity(0.12) : .clear,
            in: RoundedRectangle(cornerRadius: 7, style: .continuous)
        )
    }

    private func thinkingRow(_ label: LocalizedStringKey, selected: Bool) -> some View {
        HStack(spacing: 5) {
            OnboardingArtSymbol(
                name: "checkmark",
                size: 7,
                weight: .bold,
                color: selected ? palette.accent : .clear
            )
            OnboardingArtText(
                label,
                size: 8.5,
                weight: selected ? .semibold : .medium,
                style: .primary
            )
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 6)
        .frame(height: 21)
        .background(
            selected ? palette.accent.opacity(0.12) : .clear,
            in: RoundedRectangle(cornerRadius: 8, style: .continuous)
        )
    }
}

/// Automate and stay in control: the Scheduled Tasks list with its real cadence
/// labels, and one task's actions ready to run now or pause.
struct AidenOnboardingControlArt: View {
    private struct Row {
        let name: CGFloat
        let schedule: String
        let enabled: Bool
        var running = false
    }

    private static let tasks = [
        Row(name: 64, schedule: "0 9 * * *", enabled: true, running: true),
        Row(name: 50, schedule: "0 17 * * 1-5", enabled: false),
        Row(name: 74, schedule: "0 * * * *", enabled: true),
        Row(name: 56, schedule: "*/30 * * * *", enabled: true),
    ]

    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenOnboardingArtColors) private var colors
    let motion: AidenOnboardingArtMotion

    var body: some View {
        ZStack(alignment: .topLeading) {
            OnboardingArtWindow(origin: CGPoint(x: 14, y: 12), width: 172, height: 236, cornerRadius: 20, padding: 10) {
                HStack(spacing: 4) {
                    OnboardingArtText("Scheduled Tasks", size: 10, weight: .bold, style: .primary)
                    Spacer(minLength: 0)
                    OnboardingArtSymbol(name: "gearshape", size: 8, color: palette.accent)
                    OnboardingArtSymbol(name: "ellipsis", size: 8, color: palette.accent)
                }
                .padding(.bottom, 8)

                segmentedControl
                    .padding(.bottom, 9)

                OnboardingArtText("TASKS", size: 6.5, weight: .semibold, style: .tertiary)
                    .padding(.leading, 6)
                    .padding(.bottom, 4)

                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Self.tasks.indices, id: \.self) { index in
                        if index > 0 { OnboardingArtSeparator(leadingInset: 8) }
                        taskRow(Self.tasks[index])
                    }
                }
                .background(palette.raised, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            }

            OnboardingArtWindow(origin: CGPoint(x: 178, y: 78), width: 108, raised: true, cornerRadius: 12, padding: 3) {
                actionRow("Run Now", symbol: "play.fill")
                    .scaleEffect(motion.press(delay: 0.6), anchor: .leading)
                OnboardingArtSeparator(leadingInset: 24)
                actionRow("Pause", symbol: "pause")
                OnboardingArtSeparator(leadingInset: 24)
                actionRow("Edit", symbol: "pencil")
            }
            .offset(y: motion.float)
        }
    }

    private var segmentedControl: some View {
        HStack(spacing: 0) {
            ForEach(["All", "Active", "Paused"], id: \.self) { title in
                OnboardingArtText(
                    LocalizedStringKey(title),
                    size: 7,
                    weight: title == "All" ? .semibold : .medium,
                    style: title == "All" ? .primary : .secondary
                )
                .frame(maxWidth: .infinity)
                .frame(height: 15)
                .background(title == "All" ? palette.raised : .clear, in: Capsule())
            }
        }
        .padding(2)
        .background(colors.fill, in: Capsule())
    }

    private func taskRow(_ task: Row) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                OnboardingArtBar(width: task.name, tone: task.enabled ? .ink : .regular)
                if task.running {
                    Circle()
                        .fill(palette.success)
                        .frame(width: 5, height: 5)
                        .scaleEffect(1.3 - 0.3 * motion.pulse)
                        .opacity(0.55 + 0.45 * motion.pulse)
                }
                Spacer(minLength: 0)
                OnboardingArtText(task.enabled ? "Active" : "Paused", size: 6.5)
            }
            OnboardingArtText(
                verbatim: AidenScheduledTaskPresentation.cadence(schedule: task.schedule),
                size: 7
            )
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
    }

    private func actionRow(_ title: LocalizedStringKey, symbol: String) -> some View {
        HStack(spacing: 5) {
            OnboardingArtSymbol(name: symbol, size: 7.5, color: palette.accent)
            OnboardingArtText(title, size: 8.5, style: .accent)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .frame(height: 22)
    }
}

/// Desktop's `oa-anim-pop`: a row rising 4 pt into place as it fades in.
struct OnboardingArtPop: ViewModifier {
    let reveal: AidenOnboardingArtMotion.Reveal

    func body(content: Content) -> some View {
        content
            .opacity(reveal.amount * reveal.opacity)
            .offset(y: 4 * (1 - reveal.amount))
    }
}
