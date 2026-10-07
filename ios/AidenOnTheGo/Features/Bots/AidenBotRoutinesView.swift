import SwiftUI

/// The frequency choices, in the order the editor offers them.
enum AidenBotRoutineFrequency: String, CaseIterable, Identifiable {
    case once, daily, weekdays, weekly, monthly

    var id: String { rawValue }

    var title: String {
        switch self {
        case .once: "Once"
        case .daily: "Every day"
        case .weekdays: "Weekdays"
        case .weekly: "Weekly"
        case .monthly: "Monthly"
        }
    }
}

/// Local edits to one routine. Times stay 24-hour `HH:MM` strings so the
/// draft maps exactly onto the wire schedule.
struct AidenBotRoutineDraft: Equatable {
    var name = ""
    var message = ""
    var frequency: AidenBotRoutineFrequency = .daily
    var hour = 8
    var minute = 0
    var weekdays: Set<Int> = [1]
    var dayOfMonth = 1
    var onceDate = Date()
    var enabled = true

    init() {}

    init(routine: AidenBotRoutine) {
        name = routine.name
        message = routine.message
        enabled = routine.enabled
        guard let schedule = routine.schedule else { return }
        let parts = schedule.time.split(separator: ":").compactMap { Int($0) }
        if parts.count == 2 { hour = parts[0]; minute = parts[1] }
        switch schedule {
        case let .once(date, _):
            frequency = .once
            onceDate = Self.dateFormatter.date(from: date) ?? Date()
        case .daily: frequency = .daily
        case .weekdays: frequency = .weekdays
        case let .weekly(days, _):
            frequency = .weekly
            weekdays = Set(days)
        case let .monthly(day, _):
            frequency = .monthly
            dayOfMonth = day
        }
    }

    var time: String { String(format: "%02d:%02d", hour, minute) }

    func schedule() throws -> AidenBotRoutineSchedule {
        let schedule: AidenBotRoutineSchedule = switch frequency {
        case .once: .once(date: Self.dateFormatter.string(from: onceDate), time: time)
        case .daily: .daily(time: time)
        case .weekdays: .weekdays(time: time)
        case .weekly: .weekly(days: weekdays.sorted(), time: time)
        case .monthly: .monthly(day: dayOfMonth, time: time)
        }
        return try schedule.validated()
    }

    func createRequest(timezone: String = TimeZone.current.identifier) throws -> AidenBotRoutineCreateRequest {
        try AidenBotRoutineCreateRequest(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            schedule: schedule(),
            message: message.trimmingCharacters(in: .whitespacesAndNewlines),
            timezone: timezone
        )
    }

    /// The fields that changed, or nil when nothing did.
    func updateRequest(comparedTo routine: AidenBotRoutine) throws -> AidenBotRoutineUpdateRequest? {
        let nextName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let nextMessage = message.trimmingCharacters(in: .whitespacesAndNewlines)
        let nextSchedule = try schedule()
        let changedName = nextName == routine.name ? nil : nextName
        let changedMessage = nextMessage == routine.message ? nil : nextMessage
        let changedSchedule = nextSchedule == routine.schedule ? nil : nextSchedule
        guard changedName != nil || changedMessage != nil || changedSchedule != nil else { return nil }
        return try AidenBotRoutineUpdateRequest(
            name: changedName,
            schedule: changedSchedule,
            message: changedMessage,
            timezone: changedSchedule == nil ? nil : TimeZone.current.identifier
        )
    }

    var isSaveable: Bool { (try? createRequest()) != nil }

    static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()
}

/// Profile → Routines: each routine's name, the host's schedule label, and an
/// enabled toggle, plus "Add routine".
struct AidenBotRoutinesSection: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let botID: String
    let canWrite: Bool

    @Environment(\.aidenPalette) private var palette
    @State private var routines: [AidenBotRoutine] = []
    @State private var isLoaded = false
    @State private var editing: AidenBotRoutineEditorTarget?
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Routines")
                .font(.subheadline)
                .foregroundStyle(palette.secondary)
                .padding(.horizontal, 16)
            VStack(spacing: 0) {
                ForEach(routines) { routine in
                    row(routine)
                    Divider().padding(.leading, 16)
                }
                Button {
                    editing = .new
                } label: {
                    Label("Add routine", systemImage: "plus")
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(palette.accent)
                .disabled(!canWrite || !isLoaded)
            }
            .background(palette.raised, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            if let errorMessage {
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(palette.danger)
                    .padding(.horizontal, 16)
            }
        }
        .task(id: botID) { await load() }
        .sheet(item: $editing) { target in
            AidenBotRoutineEditorView(
                coordinator: coordinator,
                botID: botID,
                routine: target.routine
            ) { change in
                switch change {
                case let .saved(routine):
                    routines.removeAll { $0.id == routine.id }
                    routines.append(routine)
                case let .deleted(id):
                    routines.removeAll { $0.id == id }
                }
            }
        }
    }

    private func row(_ routine: AidenBotRoutine) -> some View {
        HStack(spacing: 12) {
            Button {
                editing = .existing(routine)
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(routine.name)
                        .foregroundStyle(palette.foreground)
                    Text(routine.label)
                        .font(.footnote)
                        .foregroundStyle(palette.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!canWrite)
            Toggle(routine.name, isOn: Binding(
                get: { routine.enabled },
                set: { enabled in Task { await setEnabled(routine, enabled) } }
            ))
            .labelsHidden()
            .disabled(!canWrite)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    @MainActor
    private func load() async {
        guard let context = try? coordinator.requestContext(),
              let client = try? coordinator.remoteClient(for: context) else { return }
        do {
            let loaded = try await client.botRoutines(botId: botID)
            guard coordinator.isCurrent(context) else { return }
            routines = loaded
            isLoaded = true
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            errorMessage = "Routines couldn’t be loaded."
        }
    }

    @MainActor
    private func setEnabled(_ routine: AidenBotRoutine, _ enabled: Bool) async {
        guard let context = try? coordinator.requestContext(),
              let client = try? coordinator.remoteClient(for: context),
              let request = try? AidenBotRoutineUpdateRequest(enabled: enabled) else { return }
        do {
            let updated = try await client.updateBotRoutine(
                botId: botID,
                routineId: routine.id,
                revision: routine.revision,
                request: request
            )
            guard let index = routines.firstIndex(where: { $0.id == updated.id }) else { return }
            routines[index] = updated
        } catch {
            errorMessage = "That change wasn’t saved. Please try again."
            await load()
        }
    }
}

enum AidenBotRoutineEditorTarget: Identifiable {
    case new
    case existing(AidenBotRoutine)

    var id: String {
        switch self {
        case .new: "new"
        case let .existing(routine): routine.id
        }
    }

    var routine: AidenBotRoutine? {
        if case let .existing(routine) = self { return routine }
        return nil
    }
}

enum AidenBotRoutineChange {
    case saved(AidenBotRoutine)
    case deleted(String)
}

/// Name, then frequency first, then the day and time, then what to do.
struct AidenBotRoutineEditorView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let botID: String
    let routine: AidenBotRoutine?
    let onChange: (AidenBotRoutineChange) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette
    @State private var draft = AidenBotRoutineDraft()
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var createKey = UUID()
    @State private var isConfirmingDelete = false

    private static let weekdaySymbols = Calendar(identifier: .gregorian).veryShortWeekdaySymbols
    private static let weekdayNames = Calendar(identifier: .gregorian).weekdaySymbols

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $draft.name)
                }
                Section("How often") {
                    Picker("Frequency", selection: $draft.frequency) {
                        ForEach(AidenBotRoutineFrequency.allCases) { Text($0.title).tag($0) }
                    }
                    switch draft.frequency {
                    case .once:
                        DatePicker("Date", selection: $draft.onceDate, displayedComponents: .date)
                    case .weekly:
                        weekdayChips
                    case .monthly:
                        Picker("Day of the month", selection: $draft.dayOfMonth) {
                            ForEach(1...31, id: \.self) { Text("\($0)").tag($0) }
                        }
                    case .daily, .weekdays:
                        EmptyView()
                    }
                    DatePicker("Time", selection: timeBinding, displayedComponents: .hourAndMinute)
                }
                Section("What should it do?") {
                    TextField("For example, give me a short brief for today.", text: $draft.message, axis: .vertical)
                        .lineLimit(3...8)
                }
                if routine != nil {
                    Section {
                        Button("Delete Routine", role: .destructive) { isConfirmingDelete = true }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(palette.canvas)
            .disabled(isSaving)
            .navigationTitle(routine == nil ? "New Routine" : "Routine")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(isSaving || !draft.isSaveable)
                }
            }
            .confirmationDialog("Delete this routine?", isPresented: $isConfirmingDelete, titleVisibility: .visible) {
                Button("Delete Routine", role: .destructive) { Task { await delete() } }
                Button("Cancel", role: .cancel) {}
            }
            .alert(
                "Couldn’t Save",
                isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })
            ) {
                Button("OK", role: .cancel) { errorMessage = nil }
            } message: {
                Text(errorMessage ?? "")
            }
        }
        .onAppear {
            if let routine { draft = AidenBotRoutineDraft(routine: routine) }
        }
    }

    private var weekdayChips: some View {
        HStack(spacing: 6) {
            ForEach(0..<7, id: \.self) { day in
                let selected = draft.weekdays.contains(day)
                Button {
                    if selected, draft.weekdays.count > 1 {
                        draft.weekdays.remove(day)
                    } else {
                        draft.weekdays.insert(day)
                    }
                } label: {
                    Text(Self.weekdaySymbols[day])
                        .font(.subheadline.weight(.semibold))
                        .frame(width: 36, height: 36)
                        .foregroundStyle(selected ? palette.onAccent : palette.foreground)
                        .background(selected ? palette.accent : palette.raised, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Self.weekdayNames[day])
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
    }

    private var timeBinding: Binding<Date> {
        Binding(
            get: {
                Calendar.current.date(bySettingHour: draft.hour, minute: draft.minute, second: 0, of: Date()) ?? Date()
            },
            set: { date in
                let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
                draft.hour = parts.hour ?? 0
                draft.minute = parts.minute ?? 0
            }
        )
    }

    @MainActor
    private func save() async {
        guard let context = try? coordinator.requestContext(),
              let client = try? coordinator.remoteClient(for: context) else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            if let routine {
                guard let request = try draft.updateRequest(comparedTo: routine) else {
                    dismiss()
                    return
                }
                let updated = try await client.updateBotRoutine(
                    botId: botID,
                    routineId: routine.id,
                    revision: routine.revision,
                    request: request
                )
                onChange(.saved(updated))
            } else {
                let created = try await client.createBotRoutine(
                    botId: botID,
                    request: try draft.createRequest(),
                    idempotencyKey: createKey
                )
                onChange(.saved(created))
            }
            dismiss()
        } catch {
            if !aidenBotSessionFailureIsAmbiguous(error) { createKey = UUID() }
            errorMessage = error.localizedDescription
        }
    }

    @MainActor
    private func delete() async {
        guard let routine, let context = try? coordinator.requestContext(),
              let client = try? coordinator.remoteClient(for: context) else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            try await client.deleteBotRoutine(botId: botID, routineId: routine.id, revision: routine.revision)
            onChange(.deleted(routine.id))
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
