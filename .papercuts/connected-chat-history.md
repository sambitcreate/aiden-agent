# Connected chat history

- A fresh checkout running `test:aiden-remote` built the file I/O helper, then Bot integration cases failed with ENOENT for `build/native/aiden-lease-flock`. Build the lease helper before running the suite.
- The existing local dependency tree lacked the locked posthog-node package. Install the worktree lockfile before type-checking.
- The physical LAN test fixture passes zero certificate-validity days to openssl x509. Homebrew OpenSSL 4 rejects this before the test server starts.
  Running the LAN suite with Homebrew OpenSSL 3.5 passed all seven cases.
