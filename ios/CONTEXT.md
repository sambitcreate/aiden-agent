# Aiden On The Go terms

- **Aiden installation:** one paired Aiden Agent Mac, identified by its server-issued instance ID.
- **Device credential:** the per-phone or per-iPad bearer secret stored only in Keychain and revocable on the Mac.
- **Workspace:** an Aiden registry entry with `full`, `ask`, or `none` permission.
- **Approved root:** a Mac folder explicitly exposed for remote browsing by a local desktop action.
- **Location handle:** a short-lived opaque browser capability; never a filesystem path.
- **Selection:** a short-lived, single-use capability consumed atomically when registering a selected folder.
- **Remote turn:** one idempotently admitted user message whose generation remains owned by Aiden Agent across network loss.
