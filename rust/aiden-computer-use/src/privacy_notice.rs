//! Pure first-enable privacy-notice state.
//!
//! The GPUI root owns focus trapping and durable preference I/O. This reducer
//! only decides whether a chat enable may proceed, so rendering or booting can
//! never enable Computer Use or request permissions.

pub const COMPUTER_USE_NOTICE_VERSION: u64 = 1;
pub const COMPUTER_USE_NOTICE_DISMISSED_KEY: &str = "computerUseNoticeDismissedVersion";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComputerUseNoticeDismissal {
    Session,
    Permanent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComputerUseEnableIntent {
    Proceed,
    ShowPrivacyNotice,
}

#[derive(Debug, Default)]
pub struct ComputerUsePrivacyNoticeState {
    session_dismissed: bool,
    permanent_version: Option<u64>,
    pending_chat_enable: bool,
}

impl ComputerUsePrivacyNoticeState {
    /// Inert hydration of the durable notice version.
    pub fn hydrate(&mut self, permanent_version: Option<u64>) {
        self.permanent_version = permanent_version;
    }

    pub fn request_chat_enable(&mut self) -> ComputerUseEnableIntent {
        if self.dismissed() {
            self.pending_chat_enable = false;
            ComputerUseEnableIntent::Proceed
        } else {
            self.pending_chat_enable = true;
            ComputerUseEnableIntent::ShowPrivacyNotice
        }
    }

    /// Returns true exactly once when the pending chat enable may continue.
    pub fn accept(&mut self, scope: ComputerUseNoticeDismissal) -> bool {
        if !self.pending_chat_enable {
            return false;
        }
        self.pending_chat_enable = false;
        match scope {
            ComputerUseNoticeDismissal::Session => self.session_dismissed = true,
            ComputerUseNoticeDismissal::Permanent => {
                self.permanent_version = Some(COMPUTER_USE_NOTICE_VERSION)
            }
        }
        true
    }

    pub fn cancel(&mut self) {
        self.pending_chat_enable = false;
    }

    pub fn restore(&mut self) {
        self.session_dismissed = false;
        self.permanent_version = None;
        self.pending_chat_enable = false;
    }

    pub fn is_open(&self) -> bool {
        self.pending_chat_enable
    }

    pub fn dismissed(&self) -> bool {
        self.session_dismissed || self.permanent_version == Some(COMPUTER_USE_NOTICE_VERSION)
    }

    pub fn permanent_version(&self) -> Option<u64> {
        self.permanent_version
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_enable_pauses_until_the_privacy_notice_is_explicitly_accepted() {
        let mut state = ComputerUsePrivacyNoticeState::default();
        assert_eq!(
            state.request_chat_enable(),
            ComputerUseEnableIntent::ShowPrivacyNotice
        );
        assert!(state.is_open());
        assert!(state.accept(ComputerUseNoticeDismissal::Session));
        assert!(!state.accept(ComputerUseNoticeDismissal::Session));
        assert_eq!(
            state.request_chat_enable(),
            ComputerUseEnableIntent::Proceed
        );
    }

    #[test]
    fn cancelling_never_grants_the_pending_enable() {
        let mut state = ComputerUsePrivacyNoticeState::default();
        state.request_chat_enable();
        state.cancel();
        assert!(!state.is_open());
        assert!(!state.accept(ComputerUseNoticeDismissal::Session));
        assert!(!state.dismissed());
    }

    #[test]
    fn only_the_current_notice_version_is_dismissed_and_restore_reopens_it() {
        let mut state = ComputerUsePrivacyNoticeState::default();
        state.hydrate(Some(COMPUTER_USE_NOTICE_VERSION - 1));
        assert!(!state.dismissed());
        state.hydrate(Some(COMPUTER_USE_NOTICE_VERSION));
        assert!(state.dismissed());
        state.restore();
        assert!(!state.dismissed());
        assert_eq!(state.permanent_version(), None);
    }
}
