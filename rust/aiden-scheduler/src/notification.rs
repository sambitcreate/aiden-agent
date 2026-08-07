//! Port of `main/services/schedule-notification.ts` — the pure decision logic
//! behind a scheduled-run notification.
//!
//! The TS module injects a small notification façade (`isSupported`, `create`,
//! `openChat`); the same shape is a trait here so the runtime binding can wire
//! `aiden-mac::notify` later without this module knowing about macOS.

use std::sync::Arc;

use aiden_data::schedule_store::ScheduledTask;

/// A created notification handle (mirrors Electron `Notification`).
pub trait NotificationHandle: Send {
    /// Register the click listener. Fired when the user clicks the banner.
    fn on_click(&self, handler: Box<dyn FnOnce() + Send>);
    /// Present the notification.
    fn show(&self);
}

/// The injected notification façade (`ScheduledNotificationDependencies`).
pub trait NotificationBackend: Send + Sync {
    fn is_supported(&self) -> bool;
    fn create(&self, title: String, body: String) -> Box<dyn NotificationHandle + Send>;
    fn open_chat(&self, chat_id: &str);
}

/// `showScheduledNotification` — decide, build, wire, and show.
///
/// Returns whether a notification was shown. Honors the task's `notify` opt-out
/// and platform support; the body is collapsed to single spaces, trimmed, and
/// truncated to 120 chars; clicking a notification that has a dedicated chat
/// opens that chat.
pub fn show_scheduled_notification(
    task: &ScheduledTask,
    body: &str,
    chat_id: Option<&str>,
    backend: Arc<dyn NotificationBackend>,
) -> bool {
    if !task.notify || !backend.is_supported() {
        return false;
    }
    let body: String = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let body: String = body.chars().take(120).collect();
    let notification = backend.create(task.name.clone(), body);
    if let Some(chat_id) = chat_id {
        let chat_id = chat_id.to_string();
        let open_chat = Arc::clone(&backend);
        notification.on_click(Box::new(move || {
            open_chat.open_chat(&chat_id);
        }));
    }
    notification.show();
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiden_data::schedule_store::{ScheduledTaskMode, ScheduledTaskPermission};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Mutex;

    fn task(notify: bool) -> ScheduledTask {
        ScheduledTask {
            id: "task-1".into(),
            name: "Daily brief".into(),
            enabled: true,
            mode: ScheduledTaskMode::Llm,
            cron: "0 9 * * *".into(),
            timezone: "UTC".into(),
            next_run_at: None,
            last_run_at: None,
            workspace_id: None,
            provider_id: None,
            model: None,
            provider_fingerprint: None,
            prompt: None,
            script: None,
            permission: ScheduledTaskPermission::ReadOnly,
            mcp_server_ids: None,
            mcp_server_bindings: None,
            execution_profile: None,
            chat_id: None,
            notify,
            last_result: None,
            last_error: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    struct Clickable {
        click: Mutex<Option<Box<dyn FnOnce() + Send>>>,
        shown: AtomicBool,
    }

    impl Clickable {
        fn click(&self) {
            if let Some(handler) = self.click.lock().unwrap().take() {
                handler();
            }
        }
    }

    struct Handle {
        inner: Arc<Clickable>,
    }

    impl NotificationHandle for Handle {
        fn on_click(&self, handler: Box<dyn FnOnce() + Send>) {
            *self.inner.click.lock().unwrap() = Some(handler);
        }
        fn show(&self) {
            self.inner.shown.store(true, Ordering::SeqCst);
        }
    }

    struct Captured {
        created: Arc<Mutex<Vec<(String, String, Arc<Clickable>)>>>,
        opens: Arc<Mutex<Vec<String>>>,
    }

    impl NotificationBackend for Captured {
        fn is_supported(&self) -> bool {
            true
        }
        fn create(&self, title: String, body: String) -> Box<dyn NotificationHandle + Send> {
            let clickable = Arc::new(Clickable {
                click: Mutex::new(None),
                shown: AtomicBool::new(false),
            });
            self.created
                .lock()
                .unwrap()
                .push((title, body, clickable.clone()));
            Box::new(Handle { inner: clickable })
        }
        fn open_chat(&self, chat_id: &str) {
            self.opens.lock().unwrap().push(chat_id.to_string());
        }
    }

    struct Unsupported {
        created: Arc<AtomicUsize>,
    }

    impl NotificationBackend for Unsupported {
        fn is_supported(&self) -> bool {
            false
        }
        fn create(&self, _title: String, _body: String) -> Box<dyn NotificationHandle + Send> {
            self.created.fetch_add(1, Ordering::SeqCst);
            Box::new(Handle {
                inner: Arc::new(Clickable {
                    click: Mutex::new(None),
                    shown: AtomicBool::new(false),
                }),
            })
        }
        fn open_chat(&self, _chat_id: &str) {}
    }

    #[test]
    fn notification_truncates_output_and_opens_the_dedicated_chat_on_click() {
        let created: Arc<Mutex<Vec<(String, String, Arc<Clickable>)>>> =
            Arc::new(Mutex::new(Vec::new()));
        let opens: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let backend: Arc<dyn NotificationBackend> = Arc::new(Captured {
            created: created.clone(),
            opens: opens.clone(),
        });
        let body = format!("  {}  ", "result ".repeat(30));
        let shown =
            show_scheduled_notification(&task(true), &body, Some("chat-1"), Arc::clone(&backend));
        assert!(shown);

        let captured = created.lock().unwrap().clone();
        let (title, body, handle) = &captured[0];
        assert_eq!(title, "Daily brief");
        assert_eq!(body.chars().count(), 120);
        // `\s+` collapsed to a single space, then sliced to 120 code points.
        let collapsed = body.split_whitespace().collect::<Vec<_>>().join(" ");
        let expected: String = collapsed.chars().take(120).collect();
        assert_eq!(body, &expected);
        assert!(body.starts_with("result result result"));
        handle.click();
        assert_eq!(*opens.lock().unwrap(), vec!["chat-1".to_string()]);
    }

    #[test]
    fn notification_honors_task_opt_out_and_platform_support() {
        let created: Arc<Mutex<Vec<(String, String, Arc<Clickable>)>>> =
            Arc::new(Mutex::new(Vec::new()));
        let opens: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let backend: Arc<dyn NotificationBackend> = Arc::new(Captured {
            created: created.clone(),
            opens,
        });
        assert!(!show_scheduled_notification(
            &task(false),
            "done",
            Some("chat-1"),
            Arc::clone(&backend)
        ));
        assert_eq!(created.lock().unwrap().len(), 0);

        let unsupported_created = Arc::new(AtomicUsize::new(0));
        let unsupported: Arc<dyn NotificationBackend> = Arc::new(Unsupported {
            created: unsupported_created.clone(),
        });
        assert!(!show_scheduled_notification(
            &task(true),
            "done",
            Some("chat-1"),
            unsupported.clone()
        ));
        assert_eq!(unsupported_created.load(Ordering::SeqCst), 0);
    }
}
