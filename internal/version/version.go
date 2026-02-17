package version

// Version is the application version. Override via ldflags:
//
//	go build -ldflags "-X openclawdeck/internal/version.Version=1.2.3 -X openclawdeck/internal/version.Build=153 -X openclawdeck/internal/version.OpenClawCompat=>=2025.1.15"
var Version = "0.0.1"

// Build is the build number, injected at compile time.
var Build = "dev"

// OpenClawCompat is the minimum compatible OpenClaw version (e.g. ">=2025.1.15").
var OpenClawCompat = ">=2025.1.15"
