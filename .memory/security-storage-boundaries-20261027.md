# Security storage boundaries, 2026-10-27

W3a: portable DataStore preparation validates the dedicated root and protects config, strict recovery names and local legacy archives before reads or writes. POSIX files publish as 0600, portable root as 0700. Preparation errors propagate instead of becoming default config; migration remains deferred without overwriting unsafe files. Symlinks, foreign ownership, hard links and replaceable ancestors fail closed. Windows ACL equivalence is not claimed. Filesystem ancestry checks resolve normal macOS ancestor aliases. No recursive chmod or user-secret inspection.

W3a local checks: portable/config/DataStore suites pass 301 tests; root TypeScript and scoped ESLint pass. Unsafe config special-file and archive-symlink expectations now explicitly require rejection without changing their bytes. No Linux or Windows ACL acceptance was performed.
