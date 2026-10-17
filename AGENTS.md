# Development defaults

- Unless the user explicitly requests a release or package, do not increment versions or generate install archives. Keep existing release archives unchanged.
- Use build/typecheck and the existing test commands as needed. Integration checks link the built directory into disposable profiles; release-packing checks are separate and explicit.
- DuoLink owns independent configuration, storage and protocol namespaces. Do not add old `dsh-session-link` aliases, path fallbacks, automatic imports or migrations.
- Leave old-plugin files and actual user profiles untouched unless the user explicitly requests changes to them.
