# Release notes

A file named for a release tag, such as `v0.62.0.md`, is placed in that GitHub release's notes by `scripts/publish-github-release.sh`, between the Beta line and GitHub's generated list of merged pull requests. Add one in the version-bump pull request when a release needs words of its own, such as a one-way data migration. Releases without a file get only the generated list.

These files are history: add a new file for each release instead of rewriting an old one.
