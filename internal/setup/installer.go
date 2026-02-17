package setup

import (
	"context"
	"encoding/json"
	"fmt"
	"openclawdeck/internal/openclaw"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// InstallConfig 安装配置
type InstallConfig struct {
	Provider string `json:"provider"` // anthropic | openai | ...
	APIKey   string `json:"apiKey"`
	Model    string `json:"model,omitempty"`
	BaseURL  string `json:"baseUrl,omitempty"`
	// 安装选项
	Version           string `json:"version,omitempty"`           // "openclaw"
	Registry          string `json:"registry,omitempty"`          // npm 镜像源
	SkipConfig        bool   `json:"skipConfig,omitempty"`        // 跳过配置
	SkipGateway       bool   `json:"skipGateway,omitempty"`       // 跳过启动 Gateway
	InstallZeroTier   bool   `json:"installZeroTier,omitempty"`   // 安装 ZeroTier
	ZerotierNetworkId string `json:"zerotierNetworkId,omitempty"` // ZeroTier Network ID
	InstallTailscale  bool   `json:"installTailscale,omitempty"`  // 安装 Tailscale
	SudoPassword      string `json:"sudoPassword,omitempty"`      // sudo 密码（非 root 且需要密码时）
}

// InstallSummaryItem 安装详单条目
type InstallSummaryItem struct {
	Label    string `json:"label"`              // 显示名称
	Status   string `json:"status"`             // ok | warn | fail | skip
	Detail   string `json:"detail,omitempty"`   // 版本号、路径等详情
	Category string `json:"category,omitempty"` // deps | optional | config | gateway
}

// InstallResult 安装结果
type InstallResult struct {
	Success      bool   `json:"success"`
	Version      string `json:"version,omitempty"`
	ConfigPath   string `json:"configPath,omitempty"`
	GatewayPort  int    `json:"gatewayPort,omitempty"`
	ErrorMessage string `json:"errorMessage,omitempty"`
	ErrorDetails string `json:"errorDetails,omitempty"`
}

// Installer 安装器
type Installer struct {
	emitter      *EventEmitter
	env          *EnvironmentReport
	sudoPassword string // sudo 密码（非 root 且需要密码时使用）
}

// NewInstaller 创建安装器
func NewInstaller(emitter *EventEmitter, env *EnvironmentReport) *Installer {
	return &Installer{
		emitter: emitter,
		env:     env,
	}
}

// newSC 创建带 sudo 密码的 StreamCommand
func (i *Installer) newSC(phase, step string) *StreamCommand {
	if i.sudoPassword != "" {
		return NewStreamCommandWithSudo(i.emitter, phase, step, i.sudoPassword)
	}
	return NewStreamCommand(i.emitter, phase, step)
}

// InstallNode 安装 Node.js（多层级降级策略）
func (i *Installer) InstallNode(ctx context.Context) error {
	if i.env.Tools["node"].Installed {
		i.emitter.EmitLog("Node.js 已安装，跳过")
		return nil
	}

	i.emitter.EmitStep("install", "install-node", "正在安装 Node.js...", 10)

	// 策略 1: 尝试系统包管理器
	i.emitter.EmitLog("尝试使用系统包管理器安装...")
	if err := i.installNodeViaPackageManager(ctx); err == nil {
		// 验证安装
		if i.verifyNodeInstalled() {
			i.emitter.EmitLog("✓ Node.js 通过系统包管理器安装成功")
			return nil
		}
		i.emitter.EmitLog("⚠ 系统包管理器安装完成但未检测到命令，可能需要重启")
	} else {
		i.emitter.EmitLog(fmt.Sprintf("系统包管理器安装失败: %v", err))
	}

	// 策略 2: 尝试 fnm (Fast Node Manager)
	if runtime.GOOS != "linux" || i.env.HasSudo {
		i.emitter.EmitLog("尝试使用 fnm 安装...")
		if err := i.installNodeViaFnm(ctx); err == nil {
			if i.verifyNodeInstalled() {
				i.emitter.EmitLog("✓ Node.js 通过 fnm 安装成功")
				return nil
			}
			i.emitter.EmitLog("⚠ fnm 安装完成但未检测到命令，可能需要重启")
		} else {
			i.emitter.EmitLog(fmt.Sprintf("fnm 安装失败: %v", err))
		}
	}

	// 策略 3: 提供手动安装指引
	i.emitter.EmitLog("自动安装失败，请手动安装 Node.js")
	return i.provideNodeInstallGuide()
}

// installNodeViaPackageManager 使用系统包管理器安装 Node.js
func (i *Installer) installNodeViaPackageManager(ctx context.Context) error {
	cmd := getNodeInstallCommand(i.env)
	if cmd == "" || strings.Contains(cmd, "请访问") {
		return fmt.Errorf("无可用的包管理器")
	}

	sc := i.newSC("install", "install-node")
	return sc.RunShell(ctx, cmd)
}

// installNodeViaFnm 使用 fnm 安装 Node.js
func (i *Installer) installNodeViaFnm(ctx context.Context) error {
	switch runtime.GOOS {
	case "windows":
		// Windows: 使用 PowerShell 安装 fnm
		if !i.env.Tools["powershell"].Installed {
			return fmt.Errorf("需要 PowerShell")
		}
		sc := NewStreamCommand(i.emitter, "install", "install-fnm")
		// 安装 fnm
		installCmd := "irm https://fnm.vercel.app/install.ps1 | iex"
		if err := sc.RunShell(ctx, installCmd); err != nil {
			return err
		}
		// 使用 fnm 安装 Node.js 22
		fnmCmd := "fnm install 22 && fnm default 22 && fnm use 22"
		return sc.RunShell(ctx, fnmCmd)

	case "darwin", "linux":
		// Unix: 使用 curl 安装 fnm
		if !i.env.Tools["curl"].Installed {
			return fmt.Errorf("需要 curl")
		}
		sc := NewStreamCommand(i.emitter, "install", "install-fnm")
		// 安装 fnm
		installCmd := "curl -fsSL https://fnm.vercel.app/install | bash"
		if err := sc.RunShell(ctx, installCmd); err != nil {
			return err
		}
		// 配置环境并安装 Node.js
		home, _ := os.UserHomeDir()
		fnmPath := filepath.Join(home, ".fnm")
		fnmCmd := fmt.Sprintf("export PATH=%s:$PATH && fnm install 22 && fnm default 22 && fnm use 22", fnmPath)
		return sc.RunShell(ctx, fnmCmd)

	default:
		return fmt.Errorf("不支持的操作系统")
	}
}

// verifyNodeInstalled 验证 Node.js 是否安装成功
func (i *Installer) verifyNodeInstalled() bool {
	// 重新扫描以检测新安装的 Node.js
	info := detectNodeWithFallback()
	return info.Installed
}

// provideNodeInstallGuide 提供 Node.js 手动安装指引
func (i *Installer) provideNodeInstallGuide() error {
	var guide string
	switch runtime.GOOS {
	case "windows":
		guide = `请手动安装 Node.js:
1. 访问 https://nodejs.org/en/download/
2. 下载 Windows 安装包（推荐 LTS 版本）
3. 运行安装程序并完成安装
4. 重启 OpenClawDeck 应用`
	case "darwin":
		guide = `请手动安装 Node.js:
方式 1 (推荐): 使用 Homebrew
  brew install node@22

方式 2: 官方安装包
  1. 访问 https://nodejs.org/en/download/
  2. 下载 macOS 安装包
  3. 运行安装程序

安装完成后重启 OpenClawDeck`
	case "linux":
		guide = `请手动安装 Node.js:
方式 1: 使用包管理器
  # Ubuntu/Debian
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs

  # Fedora/RHEL
  curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
  sudo dnf install -y nodejs

方式 2: 使用 nvm
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
  source ~/.bashrc
  nvm install 22

安装完成后重启 OpenClawDeck`
	default:
		guide = "请访问 https://nodejs.org/en/download/ 下载并安装 Node.js"
	}

	i.emitter.EmitLog(guide)
	return fmt.Errorf("需要手动安装 Node.js")
}

// InstallGit 安装 Git
func (i *Installer) InstallGit(ctx context.Context) error {
	if i.env.Tools["git"].Installed {
		i.emitter.EmitLog("Git 已安装，跳过")
		return nil
	}

	i.emitter.EmitStep("install", "install-git", "正在安装 Git...", 15)

	cmd := getGitInstallCommand(i.env)
	if cmd == "" {
		return fmt.Errorf("无法确定 Git 安装命令")
	}

	sc := i.newSC("install", "install-git")
	if err := sc.RunShell(ctx, cmd); err != nil {
		return fmt.Errorf("Git 安装失败: %w", err)
	}

	i.emitter.EmitLog("Git 安装成功")
	return nil
}

// InstallOpenClaw 安装 OpenClaw（多层级降级策略）
func (i *Installer) InstallOpenClaw(ctx context.Context) error {
	if i.env.OpenClawInstalled {
		i.emitter.EmitLog("OpenClaw 已安装，跳过")
		return nil
	}

	i.emitter.EmitStep("install", "install-openclaw", "正在安装 OpenClaw...", 30)

	// 策略 1: 优先使用 npm（最可靠）
	npmAvailable := i.env.Tools["npm"].Installed || detectTool("npm", "--version").Installed
	if npmAvailable {
		i.emitter.EmitLog("尝试使用 npm 安装...")
		if err := i.installViaNpm(ctx); err == nil {
			if i.verifyOpenClawInstalled() {
				i.emitter.EmitLog("✓ OpenClaw 通过 npm 安装成功")
				return nil
			}
			i.emitter.EmitLog("⚠ npm 安装完成但未检测到命令，可能需要重启")
		} else {
			i.emitter.EmitLog(fmt.Sprintf("npm 安装失败: %v", err))
		}
	}

	// 策略 2: 尝试官方安装脚本
	if i.env.RecommendedMethod == "installer-script" || i.env.Tools["curl"].Installed {
		i.emitter.EmitLog("尝试使用官方安装脚本...")
		if err := i.installViaScript(ctx); err == nil {
			if i.verifyOpenClawInstalled() {
				i.emitter.EmitLog("✓ OpenClaw 通过安装脚本安装成功")
				return nil
			}
			i.emitter.EmitLog("⚠ 安装脚本完成但未检测到命令，可能需要重启")
		} else {
			i.emitter.EmitLog(fmt.Sprintf("安装脚本失败: %v", err))
		}
	}

	// 策略 3: 提供手动安装指引
	i.emitter.EmitLog("自动安装失败，请手动安装 OpenClaw")
	return i.provideOpenClawInstallGuide()
}

// InstallClawHub 安装 ClawHub CLI（技能市场工具）
func (i *Installer) InstallClawHub(ctx context.Context, registry string) error {
	if detectTool("clawhub", "--version").Installed {
		i.emitter.EmitLog("ClawHub CLI 已安装，跳过")
		return nil
	}

	i.emitter.EmitStep("install", "install-clawhub", "正在安装 ClawHub CLI...", 40)

	if !i.env.Tools["npm"].Installed {
		i.emitter.EmitLog("⚠️ npm 不可用，跳过 ClawHub CLI 安装")
		return nil // 非致命错误
	}

	i.emitter.EmitLog("使用 npm 全局安装 clawhub...")
	if err := i.installViaNpmWithOptions(ctx, "clawhub", registry); err != nil {
		i.emitter.EmitLog(fmt.Sprintf("⚠️ ClawHub CLI 安装失败: %v（跳过）", err))
		return nil // 非致命错误，不阻断安装流程
	}

	if detectTool("clawhub", "--version").Installed {
		i.emitter.EmitLog("✓ ClawHub CLI 安装成功")
	} else {
		i.emitter.EmitLog("⚠️ ClawHub CLI 安装完成但未检测到命令，可能需要重启")
	}
	return nil
}

// verifyOpenClawInstalled 验证 OpenClaw 是否安装成功
func (i *Installer) verifyOpenClawInstalled() bool {
	// 重新检测
	info := detectTool("openclaw", "--version")
	return info.Installed
}

// InstallOpenClawWithConfig 使用配置安装 OpenClaw（支持镜像源选择）
func (i *Installer) InstallOpenClawWithConfig(ctx context.Context, config InstallConfig) error {
	i.emitter.EmitStep("install", "install-openclaw", "正在安装 OpenClaw...", 30)

	cmdName := "openclaw"

	// 使用 npm 全局安装（所有平台统一方案）
	if i.env.Tools["npm"].Installed || detectTool("npm", "--version").Installed {
		i.emitter.EmitLog("使用 npm 全局安装...")
		if err := i.installViaNpmWithOptions(ctx, "openclaw", config.Registry); err == nil {
			if detectTool(cmdName, "--version").Installed {
				i.emitter.EmitLog("✓ OpenClaw 通过 npm 安装成功")
				return nil
			}
			i.emitter.EmitLog("⚠ npm 安装完成但未检测到命令，可能需要重启")
			// 即使未检测到命令，也认为安装成功（可能需要重启）
			return nil
		} else {
			i.emitter.EmitLog(fmt.Sprintf("npm 安装失败: %v", err))
		}
	}

	// 策略 3: 提供手动安装指引
	i.emitter.EmitLog("自动安装失败，请手动安装 OpenClaw")
	return i.provideOpenClawInstallGuideWithVersion(config.Version)
}

// provideOpenClawInstallGuideWithVersion 提供 OpenClaw 手动安装指引
func (i *Installer) provideOpenClawInstallGuideWithVersion(version string) error {
	guide := `请手动安装 openclaw:

方式 1 (推荐): 使用 npm
  npm install -g openclaw@latest

方式 2: 使用官方安装脚本`

	switch runtime.GOOS {
	case "windows":
		guide += `
  # PowerShell
  iwr -useb https://openclaw.ai/install.ps1 | iex`
	case "darwin", "linux":
		guide += `
  # Bash
  curl -fsSL https://openclaw.ai/install.sh | bash`
	}

	guide += `

安装完成后:
  1. 运行 'openclaw config set gateway.mode local' 初始化配置
  2. 重启 OpenClawDeck 应用
  3. 访问文档: https://docs.openclaw.ai`

	i.emitter.EmitLog(guide)
	return fmt.Errorf("需要手动安装 openclaw")
}

// provideOpenClawInstallGuide 提供 OpenClaw 手动安装指引
func (i *Installer) provideOpenClawInstallGuide() error {
	guide := `请手动安装 OpenClaw:

方式 1 (推荐): 使用 npm
  npm install -g openclaw@latest

方式 2: 使用官方安装脚本`

	switch runtime.GOOS {
	case "windows":
		guide += `
  # PowerShell
  iwr -useb https://openclaw.ai/install.ps1 | iex`
	case "darwin", "linux":
		guide += `
  # Bash
  curl -fsSL https://openclaw.ai/install.sh | bash`
	}

	guide += `

安装完成后:
  1. 运行 'openclaw config set gateway.mode local' 初始化配置
  2. 重启 OpenClawDeck 应用`

	i.emitter.EmitLog(guide)
	return fmt.Errorf("需要手动安装 OpenClaw")
}

// installViaScript 使用安装脚本安装（旧版，保留兼容）
func (i *Installer) installViaScript(ctx context.Context) error {
	return i.installViaScriptWithConfig(ctx, InstallConfig{Version: "openclaw"})
}

// installViaScriptWithConfig 使用安装脚本安装（支持版本和 --no-onboard）
func (i *Installer) installViaScriptWithConfig(ctx context.Context, config InstallConfig) error {
	sc := i.newSC("install", "install-openclaw")

	// 安装脚本 URL
	scriptURL := "https://openclaw.ai/install"

	// Windows
	if runtime.GOOS == "windows" {
		if !i.env.Tools["powershell"].Installed {
			return fmt.Errorf("未检测到 PowerShell")
		}
		// 使用 --no-onboard 参数跳过引导向导
		cmd := fmt.Sprintf("iwr -useb %s.ps1 | iex -Command '& { $input | iex } --no-onboard'", scriptURL)
		i.emitter.EmitLog(fmt.Sprintf("执行: %s", cmd))
		return sc.RunShell(ctx, cmd)
	}

	// 需要 curl
	if !i.env.Tools["curl"].Installed {
		return fmt.Errorf("未检测到 curl，无法自动安装")
	}

	// Linux/macOS - 使用 --no-onboard 参数
	cmd := fmt.Sprintf("curl -fsSL %s.sh | bash -s -- --no-onboard", scriptURL)
	i.emitter.EmitLog(fmt.Sprintf("执行: %s", cmd))
	return sc.RunShell(ctx, cmd)
}

// installViaNpm 使用 npm 安装
func (i *Installer) installViaNpm(ctx context.Context) error {
	return i.installViaNpmWithOptions(ctx, "openclaw", "")
}

// installViaNpmWithOptions 使用 npm 安装（支持版本和镜像源选择）
func (i *Installer) installViaNpmWithOptions(ctx context.Context, version string, registry string) error {
	sc := i.newSC("install", "install-"+version)

	pkgName := version + "@latest"
	i.emitter.EmitLog(fmt.Sprintf("安装 %s...", version))

	// 构建安装命令
	cmd := "npm install -g " + pkgName

	// 添加镜像源
	if registry != "" {
		cmd += " --registry=" + registry
		i.emitter.EmitLog(fmt.Sprintf("使用镜像源: %s", registry))
	}

	// 非 root 的 Linux/macOS 需要 sudo 执行全局安装
	if runtime.GOOS != "windows" && os.Getuid() != 0 {
		cmd = "sudo " + cmd
	}

	return sc.RunShell(ctx, cmd)
}

// ConfigureOpenClaw 通过 onboard --non-interactive 配置 OpenClaw
// 这会生成正确格式的 openclaw.json，包括网关、模型、workspace 等配置
func (i *Installer) ConfigureOpenClaw(ctx context.Context, config InstallConfig) error {
	i.emitter.EmitStep("configure", "configure-openclaw", "正在配置 OpenClaw...", 60)

	// 解析完整路径（安装后 PATH 可能未刷新）
	cmdName := resolveOpenClawFullPath("openclaw")
	i.emitter.EmitLog(fmt.Sprintf("使用命令: %s", cmdName))

	// 构建 onboard --non-interactive 参数
	args := []string{
		"onboard",
		"--non-interactive",
		"--accept-risk",
		"--mode", "local",
		"--gateway-port", "18789",
		"--gateway-bind", "loopback",
		"--skip-channels",
		"--skip-skills",
		"--skip-health",
	}

	// 自定义 provider 或带 baseUrl 的配置，onboard 无法处理，直接写入最小配置
	if config.Provider == "custom" || config.BaseURL != "" {
		i.emitter.EmitLog("自定义服务商/端点，直接写入配置...")
		return i.writeMinimalConfig(config)
	}

	// 根据 provider 设置 auth-choice 和 API Key
	if config.APIKey != "" {
		switch config.Provider {
		case "anthropic":
			args = append(args, "--anthropic-api-key", config.APIKey)
		case "openai":
			args = append(args, "--openai-api-key", config.APIKey)
		case "gemini", "google":
			args = append(args, "--gemini-api-key", config.APIKey)
		case "openrouter":
			args = append(args, "--openrouter-api-key", config.APIKey)
		case "moonshot":
			args = append(args, "--moonshot-api-key", config.APIKey)
		case "xai":
			args = append(args, "--xai-api-key", config.APIKey)
		case "deepseek", "together", "groq":
			// OpenAI 兼容 API，直接写入最小配置（onboard 不支持这些 provider）
			i.emitter.EmitLog(fmt.Sprintf("%s 使用 OpenAI 兼容 API，直接写入配置...", config.Provider))
			return i.writeMinimalConfig(config)
		default:
			args = append(args, "--auth-choice", "skip")
		}
	} else {
		args = append(args, "--auth-choice", "skip")
	}

	i.emitter.EmitLog(fmt.Sprintf("执行: %s %s", cmdName, strings.Join(maskSensitiveArgs(args), " ")))

	sc := NewStreamCommand(i.emitter, "configure", "onboard")
	if err := sc.Run(ctx, cmdName, args...); err != nil {
		i.emitter.EmitLog("onboard 命令失败，尝试写入最小配置...")
		return i.writeMinimalConfig(config)
	}

	i.emitter.EmitLog("onboard 配置完成")
	return nil
}

// maskSensitiveArgs 遮蔽敏感参数用于日志输出
func maskSensitiveArgs(args []string) []string {
	masked := make([]string, len(args))
	copy(masked, args)
	for i, arg := range masked {
		if i > 0 && (strings.HasSuffix(args[i-1], "-api-key") || strings.HasSuffix(args[i-1], "-token") || strings.HasSuffix(args[i-1], "-password")) {
			if len(arg) > 8 {
				masked[i] = arg[:4] + "****" + arg[len(arg)-4:]
			} else {
				masked[i] = "****"
			}
		}
	}
	return masked
}

// ensureDefaultConfig 确保配置文件存在，通过 openclaw onboard 生成默认配置
func (i *Installer) ensureDefaultConfig() error {
	cfgPath := GetOpenClawConfigPath()
	if cfgPath == "" {
		return fmt.Errorf("无法获取配置文件路径")
	}

	// 如果配置文件已存在且合法，不覆盖
	if exists, valid, _ := checkConfigFileValid(cfgPath); exists && valid {
		i.emitter.EmitLog(fmt.Sprintf("配置文件已存在: %s", cfgPath))
		return nil
	}

	// 通过 openclaw onboard --non-interactive 生成默认配置
	cmdName := resolveOpenClawFullPath("openclaw")
	i.emitter.EmitLog(fmt.Sprintf("使用 %s onboard 生成默认配置...", cmdName))

	args := []string{
		"onboard",
		"--non-interactive",
		"--accept-risk",
		"--mode", "local",
		"--gateway-port", "18789",
		"--gateway-bind", "loopback",
		"--anthropic-api-key", "sk-ant-placeholder-replace-me",
		"--skip-channels",
		"--skip-skills",
		"--skip-health",
	}

	i.emitter.EmitLog(fmt.Sprintf("执行: %s %s", cmdName, strings.Join(args, " ")))

	sc := NewStreamCommand(i.emitter, "configure", "onboard-default")
	if err := sc.Run(context.Background(), cmdName, args...); err != nil {
		return fmt.Errorf("onboard 生成默认配置失败: %w", err)
	}

	i.emitter.EmitLog("✅ 默认配置已通过 onboard 生成")
	i.emitter.EmitLog("⚠️ 请在配置器中添加 AI 服务商和 API Key")
	return nil
}

// writeMinimalConfig 写入最小可用配置（onboard 失败或自定义 provider 时使用）
func (i *Installer) writeMinimalConfig(config InstallConfig) error {
	configDir := ResolveStateDir()
	if configDir == "" {
		return fmt.Errorf("获取状态目录失败")
	}
	configPath := filepath.Join(configDir, "openclaw.json")

	if err := os.MkdirAll(configDir, 0755); err != nil {
		return fmt.Errorf("创建配置目录失败: %w", err)
	}

	// 确定 provider 名称（custom 映射为实际使用的 API 类型）
	providerName := config.Provider
	if providerName == "custom" {
		providerName = "custom"
	}

	// 确定默认模型
	model := config.Model
	if model == "" {
		switch providerName {
		case "anthropic":
			model = "claude-sonnet-4-20250514"
		case "openai":
			model = "gpt-4o"
		case "gemini", "google":
			model = "gemini-2.0-flash"
		case "deepseek":
			model = "deepseek-chat"
		case "moonshot":
			model = "moonshot-v1-auto"
		default:
			model = "claude-sonnet-4-20250514"
		}
	}

	// 确定默认 baseUrl
	baseUrl := config.BaseURL
	if baseUrl == "" {
		switch providerName {
		case "deepseek":
			baseUrl = "https://api.deepseek.com/v1"
		}
	}

	// 构建符合 openclaw schema 的最小配置
	minConfig := map[string]interface{}{
		"gateway": map[string]interface{}{
			"mode": "local",
			"port": 18789,
			"bind": "loopback",
		},
	}

	if config.APIKey != "" {
		// 构建 provider 配置
		providerConfig := map[string]interface{}{
			"apiKey": config.APIKey,
			"api":    "openai-completions",
			"models": []map[string]interface{}{
				{"id": model, "name": model},
			},
		}

		// 设置 API 类型
		switch providerName {
		case "anthropic":
			providerConfig["api"] = "anthropic"
		case "gemini", "google":
			providerConfig["api"] = "google-genai"
		}

		// 设置 baseUrl
		if baseUrl != "" {
			providerConfig["baseUrl"] = baseUrl
		}

		minConfig["models"] = map[string]interface{}{
			"providers": map[string]interface{}{
				providerName: providerConfig,
			},
		}

		// 设置主模型
		minConfig["agents"] = map[string]interface{}{
			"defaults": map[string]interface{}{
				"model": map[string]interface{}{
					"primary": providerName + "/" + model,
				},
			},
		}
	}

	data, err := json.MarshalIndent(minConfig, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化配置失败: %w", err)
	}

	if err := os.WriteFile(configPath, data, 0600); err != nil {
		return fmt.Errorf("写入配置文件失败: %w", err)
	}

	i.emitter.EmitLog(fmt.Sprintf("配置已写入: %s", configPath))
	return nil
}

// StartGateway 启动 Gateway
func (i *Installer) StartGateway(ctx context.Context) error {
	return i.StartGatewayWithConfig(ctx, InstallConfig{})
}

// StartGatewayWithConfig 启动 Gateway
func (i *Installer) StartGatewayWithConfig(ctx context.Context, config InstallConfig) error {
	i.emitter.EmitStep("start", "check-config", "检查配置文件...", 76)

	// 先检查配置文件是否存在且合法
	cfgPath := GetOpenClawConfigPath()
	cfgExists, cfgValid, cfgDetail := checkConfigFileValid(cfgPath)
	if !cfgExists {
		i.emitter.EmitLog("⚠️ 配置文件不存在，跳过启动 Gateway")
		i.emitter.EmitLog("请先在配置器中添加服务商和模型，再启动 Gateway")
		return nil
	}
	if !cfgValid {
		i.emitter.EmitLog(fmt.Sprintf("⚠️ 配置文件异常: %s", cfgDetail))
		i.emitter.EmitLog("请在配置器中修复配置后再启动 Gateway")
		return nil
	}
	i.emitter.EmitLog(fmt.Sprintf("✅ 配置文件正常: %s", cfgPath))

	if checkOpenClawConfigured(cfgPath) {
		i.emitter.EmitLog("✅ 模型服务商已配置")
	} else {
		i.emitter.EmitLog("⚠️ 尚未配置模型服务商，Gateway 启动后请在配置器中添加")
	}

	// 安装完成后等待 3 秒再启动网关，确保环境就绪
	for countdown := 3; countdown > 0; countdown-- {
		i.emitter.EmitLog(fmt.Sprintf("⏳ %d 秒后启动 Gateway...", countdown))
		time.Sleep(1 * time.Second)
	}

	i.emitter.EmitStep("start", "start-gateway", "正在启动 Gateway...", 80)

	// 使用与网关监控页面相同的 Service.Start() 启动网关
	svc := openclaw.NewService()
	st := svc.Status()
	if st.Running {
		i.emitter.EmitLog(fmt.Sprintf("✅ Gateway 已在运行（%s）", st.Detail))
		return nil
	}

	i.emitter.EmitLog("正在启动 Gateway...")
	if err := svc.Start(); err != nil {
		i.emitter.EmitLog(fmt.Sprintf("⚠️ 启动 Gateway 失败: %v", err))
		i.emitter.EmitLog("可稍后在网关监控页面手动启动")
		return nil // 不视为致命错误
	}

	// 等待 Gateway 就绪
	i.emitter.EmitLog("⏳ 正在等待 Gateway 就绪...")
	time.Sleep(2 * time.Second)
	for attempt := 1; attempt <= 15; attempt++ {
		st = svc.Status()
		if st.Running {
			i.emitter.EmitLog(fmt.Sprintf("✅ Gateway 已启动（%s）", st.Detail))
			return nil
		}
		i.emitter.EmitLog(fmt.Sprintf("⏳ 检测中...（%d/%d）", attempt, 15))
		time.Sleep(1 * time.Second)
	}

	// 30 秒后仍未就绪，读取日志尾部帮助诊断
	i.emitter.EmitLog("⚠️ Gateway 30 秒内未就绪")
	if stateDir := ResolveStateDir(); stateDir != "" {
		logPath := filepath.Join(stateDir, "logs", "gateway.log")
		if data, err := os.ReadFile(logPath); err == nil {
			lines := strings.Split(strings.TrimSpace(string(data)), "\n")
			start := len(lines) - 10
			if start < 0 {
				start = 0
			}
			for _, line := range lines[start:] {
				if strings.TrimSpace(line) != "" {
					i.emitter.EmitLog(fmt.Sprintf("  [gateway.log] %s", line))
				}
			}
		}
	}

	i.emitter.EmitLog("可稍后在网关监控页面手动启动")
	return nil
}

// resolveOpenClawFullPath 解析 openclaw 命令的完整路径
// 安装后当前进程的 PATH 可能未刷新，需要主动查找 npm 全局 bin 目录
func resolveOpenClawFullPath(cmdName string) string {
	// 1. 先尝试 LookPath（PATH 中已有）
	if p, err := exec.LookPath(cmdName); err == nil {
		return p
	}

	// 2. 查询 npm 全局 bin 目录
	npmBin := getNpmGlobalBin()
	if npmBin != "" {
		var candidate string
		if runtime.GOOS == "windows" {
			candidate = filepath.Join(npmBin, cmdName+".cmd")
		} else {
			candidate = filepath.Join(npmBin, cmdName)
		}
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}

	// 3. Windows 常见 npm 全局路径
	if runtime.GOOS == "windows" {
		home, _ := os.UserHomeDir()
		candidates := []string{
			filepath.Join(os.Getenv("APPDATA"), "npm", cmdName+".cmd"),
			filepath.Join(home, "AppData", "Roaming", "npm", cmdName+".cmd"),
			filepath.Join(os.Getenv("ProgramFiles"), "nodejs", cmdName+".cmd"),
		}
		for _, c := range candidates {
			if c != "" {
				if _, err := os.Stat(c); err == nil {
					return c
				}
			}
		}
	}

	// 4. 降级返回原始命令名
	return cmdName
}

// getNpmGlobalBin 获取 npm 全局 bin 目录
func getNpmGlobalBin() string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "npm", "bin", "-g").Output()
	if err != nil {
		// 降级: npm prefix -g
		out, err = exec.CommandContext(ctx, "npm", "prefix", "-g").Output()
		if err != nil {
			return ""
		}
		prefix := strings.TrimSpace(string(out))
		if runtime.GOOS == "windows" {
			return prefix
		}
		return filepath.Join(prefix, "bin")
	}
	return strings.TrimSpace(string(out))
}

// RunDoctor 运行诊断
func (i *Installer) RunDoctor(ctx context.Context) (*DoctorResult, error) {
	i.emitter.EmitStep("verify", "doctor", "正在运行诊断...", 90)

	cmd := exec.CommandContext(ctx, "openclaw", "doctor")
	output, err := cmd.CombinedOutput()

	result := &DoctorResult{
		Output: string(output),
	}

	if err != nil {
		result.Success = false
		result.Error = err.Error()
	} else {
		result.Success = true
	}

	return result, nil
}

// DoctorResult 诊断结果
type DoctorResult struct {
	Success bool   `json:"success"`
	Output  string `json:"output"`
	Error   string `json:"error,omitempty"`
}

// InstallVPNTool 安装内网穿透工具（ZeroTier 或 Tailscale）
func (i *Installer) InstallVPNTool(ctx context.Context, tool string) error {
	// 检查是否已安装
	if tool == "zerotier" {
		if detectTool("zerotier-cli", "--version").Installed {
			i.emitter.EmitLog("ZeroTier 已安装，跳过")
			return nil
		}
	} else if tool == "tailscale" {
		if detectTool("tailscale", "version").Installed {
			i.emitter.EmitLog("Tailscale 已安装，跳过")
			return nil
		}
	}

	i.emitter.EmitStep("install", "install-"+tool, fmt.Sprintf("正在安装 %s...", tool), 45)
	sc := i.newSC("install", "install-"+tool)

	switch tool {
	case "zerotier":
		switch runtime.GOOS {
		case "windows":
			// Windows: 使用 winget 或提供下载链接
			if detectTool("winget", "--version").Installed {
				return sc.RunShell(ctx, "winget install --id ZeroTier.ZeroTierOne --accept-package-agreements --accept-source-agreements")
			}
			i.emitter.EmitLog("请手动下载安装 ZeroTier: https://www.zerotier.com/download/")
			return fmt.Errorf("Windows 需要手动安装 ZeroTier（无 winget）")
		case "darwin":
			if i.env.Tools["brew"].Installed {
				return sc.RunShell(ctx, "brew install --cask zerotier-one")
			}
			i.emitter.EmitLog("请手动下载安装 ZeroTier: https://www.zerotier.com/download/")
			return fmt.Errorf("macOS 需要 Homebrew 或手动安装 ZeroTier")
		case "linux":
			return sc.RunShell(ctx, "curl -s https://install.zerotier.com | sudo bash")
		default:
			return fmt.Errorf("不支持的操作系统: %s", runtime.GOOS)
		}

	case "tailscale":
		switch runtime.GOOS {
		case "windows":
			if detectTool("winget", "--version").Installed {
				return sc.RunShell(ctx, "winget install --id tailscale.tailscale --accept-package-agreements --accept-source-agreements")
			}
			i.emitter.EmitLog("请手动下载安装 Tailscale: https://tailscale.com/download")
			return fmt.Errorf("Windows 需要手动安装 Tailscale（无 winget）")
		case "darwin":
			if i.env.Tools["brew"].Installed {
				return sc.RunShell(ctx, "brew install --cask tailscale")
			}
			i.emitter.EmitLog("请手动下载安装 Tailscale: https://tailscale.com/download")
			return fmt.Errorf("macOS 需要 Homebrew 或手动安装 Tailscale")
		case "linux":
			return sc.RunShell(ctx, "curl -fsSL https://tailscale.com/install.sh | sh")
		default:
			return fmt.Errorf("不支持的操作系统: %s", runtime.GOOS)
		}

	default:
		return fmt.Errorf("未知工具: %s", tool)
	}
}

// UpdateOpenClaw updates OpenClaw to the latest version via npm.
func (i *Installer) UpdateOpenClaw(ctx context.Context) error {
	if !i.env.Tools["npm"].Installed {
		return fmt.Errorf("npm is not available, cannot update")
	}

	sc := NewStreamCommand(i.emitter, "update", "update-openclaw")
	i.emitter.EmitLog("Running: npm update -g openclaw@latest")
	if err := sc.Run(ctx, "npm", "install", "-g", "openclaw@latest"); err != nil {
		return fmt.Errorf("npm update failed: %w", err)
	}

	i.emitter.EmitLog("✓ OpenClaw updated successfully")
	return nil
}

// skillDep describes a single skill runtime dependency to install.
type skillDep struct {
	name       string // binary name used in detectTool
	label      string // human-readable label for logs
	versionArg string // arg passed to detectTool
	// per-platform install commands (empty string = skip on that platform)
	brewFormula string // macOS: brew install <formula>
	aptPkg      string // Linux (apt): sudo apt-get install -y <pkg>
	dnfPkg      string // Linux (dnf/yum): sudo dnf install -y <pkg>
	pacmanPkg   string // Linux (pacman): sudo pacman -S --noconfirm <pkg>
	wingetID    string // Windows: winget install --id <id>
	goModule    string // fallback: go install <module>
	pipxPkg     string // fallback: pipx install <pkg>
}

// skillDeps returns the list of skill runtime dependencies to install.
func skillDeps() []skillDep {
	return []skillDep{
		{
			name: "go", label: "Go", versionArg: "version",
			brewFormula: "go", aptPkg: "golang", dnfPkg: "golang", pacmanPkg: "go", wingetID: "GoLang.Go",
		},
		{
			name: "uv", label: "uv (Python)", versionArg: "--version",
			brewFormula: "uv", aptPkg: "", dnfPkg: "", pacmanPkg: "", wingetID: "astral-sh.uv",
			// Linux: use official install script (handled specially)
		},
		{
			name: "ffmpeg", label: "FFmpeg", versionArg: "-version",
			brewFormula: "ffmpeg", aptPkg: "ffmpeg", dnfPkg: "ffmpeg", pacmanPkg: "ffmpeg", wingetID: "Gyan.FFmpeg",
		},
		{
			name: "jq", label: "jq", versionArg: "--version",
			brewFormula: "jq", aptPkg: "jq", dnfPkg: "jq", pacmanPkg: "jq", wingetID: "jqlang.jq",
		},
		{
			name: "rg", label: "ripgrep", versionArg: "--version",
			brewFormula: "ripgrep", aptPkg: "ripgrep", dnfPkg: "ripgrep", pacmanPkg: "ripgrep", wingetID: "BurntSushi.ripgrep.MSVC",
		},
	}
}

// InstallSkillDeps detects and installs missing skill runtime dependencies.
// All installs are non-fatal — failures are logged but do not block the flow.
func (i *Installer) InstallSkillDeps(ctx context.Context) {
	deps := skillDeps()
	total := len(deps)
	installed := 0
	skipped := 0

	i.emitter.EmitPhase("skill-deps", "Installing skill runtime dependencies...", 42)

	for idx, dep := range deps {
		progress := 42 + (idx*6)/total // spread across 42-48 range

		// Check if already installed
		if detectTool(dep.name, dep.versionArg).Installed {
			i.emitter.EmitLog(fmt.Sprintf("✓ %s already installed, skipping", dep.label))
			skipped++
			continue
		}

		i.emitter.EmitStep("skill-deps", "install-"+dep.name,
			fmt.Sprintf("Installing %s...", dep.label), progress)

		err := i.installSingleSkillDep(ctx, dep)
		if err != nil {
			i.emitter.EmitLog(fmt.Sprintf("⚠️ %s install failed: %v (skipping)", dep.label, err))
		} else if detectTool(dep.name, dep.versionArg).Installed {
			i.emitter.EmitLog(fmt.Sprintf("✓ %s installed successfully", dep.label))
			installed++
		} else {
			i.emitter.EmitLog(fmt.Sprintf("⚠️ %s install completed but binary not found (may need restart)", dep.label))
		}
	}

	i.emitter.EmitLog(fmt.Sprintf("Skill deps: %d installed, %d already present, %d skipped/failed",
		installed, skipped, total-installed-skipped))
}

// installSingleSkillDep installs one skill dependency using the best available method.
func (i *Installer) installSingleSkillDep(ctx context.Context, dep skillDep) error {
	sc := i.newSC("skill-deps", "install-"+dep.name)

	switch runtime.GOOS {
	case "darwin":
		// macOS: prefer brew
		if dep.brewFormula != "" && i.env.Tools["brew"].Installed {
			return sc.RunShell(ctx, fmt.Sprintf("brew install %s", dep.brewFormula))
		}

	case "linux":
		pm := i.env.PackageManager
		hasSudo := i.env.HasSudo
		// apt (Debian/Ubuntu)
		if dep.aptPkg != "" && pm == "apt" && hasSudo {
			return sc.RunShell(ctx, fmt.Sprintf("sudo apt-get install -y %s", dep.aptPkg))
		}
		// dnf (Fedora/RHEL 8+)
		if dep.dnfPkg != "" && (pm == "dnf" || pm == "yum") && hasSudo {
			return sc.RunShell(ctx, fmt.Sprintf("sudo %s install -y %s", pm, dep.dnfPkg))
		}
		// pacman (Arch/Manjaro)
		if dep.pacmanPkg != "" && pm == "pacman" && hasSudo {
			return sc.RunShell(ctx, fmt.Sprintf("sudo pacman -S --noconfirm %s", dep.pacmanPkg))
		}
		// Special case: uv — use official install script on any Linux
		if dep.name == "uv" {
			return sc.RunShell(ctx, "curl -LsSf https://astral.sh/uv/install.sh | sh")
		}

	case "windows":
		// Windows: prefer winget
		if dep.wingetID != "" && detectTool("winget", "--version").Installed {
			return sc.RunShell(ctx, fmt.Sprintf("winget install --id %s --accept-package-agreements --accept-source-agreements", dep.wingetID))
		}
	}

	// Fallback: go install (for go module deps)
	if dep.goModule != "" && detectTool("go", "version").Installed {
		return sc.Run(ctx, "go", "install", dep.goModule)
	}

	return fmt.Errorf("no suitable install method for %s on %s", dep.label, runtime.GOOS)
}

// AutoInstall 一键全自动安装
func (i *Installer) AutoInstall(ctx context.Context, config InstallConfig) (*InstallResult, error) {
	result := &InstallResult{}
	needsRestart := false

	// 设置默认值
	if config.Version == "" {
		config.Version = "openclaw" // 默认国际版
	}

	// 存储 sudo 密码
	if config.SudoPassword != "" {
		i.sudoPassword = config.SudoPassword
		// 有密码时视为有 sudo 权限
		i.env.HasSudo = true
	}

	// 阶段 1: 安装依赖
	i.emitter.EmitPhase("install", "开始安装依赖...", 0)

	// 安装 Node.js
	if !i.env.Tools["node"].Installed {
		if err := i.InstallNode(ctx); err != nil {
			result.ErrorMessage = "Node.js 安装失败"
			result.ErrorDetails = err.Error()
			i.emitter.EmitError(result.ErrorMessage, result)
			return result, err
		}
		// 刷新 node/npm 检测状态
		if nodeInfo := detectNodeWithFallback(); nodeInfo.Installed {
			i.env.Tools["node"] = nodeInfo
			if npmInfo := detectTool("npm", "--version"); npmInfo.Installed {
				i.env.Tools["npm"] = npmInfo
				i.emitter.EmitLog(fmt.Sprintf("✓ npm %s 已就绪", npmInfo.Version))
			}
		} else {
			needsRestart = true
			i.emitter.EmitLog("⚠️ Node.js 已安装但环境变量未生效，需要重启应用")
		}
	}

	// 安装 OpenClaw（使用配置的版本和镜像源）
	if !i.env.OpenClawInstalled {
		if err := i.InstallOpenClawWithConfig(ctx, config); err != nil {
			result.ErrorMessage = "OpenClaw 安装失败"
			result.ErrorDetails = err.Error()
			i.emitter.EmitError(result.ErrorMessage, result)
			return result, err
		}
		// 检查是否需要重启
		if !detectTool("openclaw", "--version").Installed {
			needsRestart = true
			i.emitter.EmitLog("⚠️ OpenClaw 已安装但环境变量未生效，需要重启应用")
		}
	}

	// 安装 ClawHub CLI（技能市场工具，非致命）
	if !needsRestart {
		if err := i.InstallClawHub(ctx, config.Registry); err != nil {
			i.emitter.EmitLog(fmt.Sprintf("⚠️ ClawHub CLI 安装失败: %v（跳过）", err))
		}
	}

	// 安装技能运行时依赖（Go, uv, ffmpeg, jq, rg — 全部非致命）
	if !needsRestart {
		i.InstallSkillDeps(ctx)
	}

	// 安装可选工具（ZeroTier / Tailscale）
	if config.InstallZeroTier || config.InstallTailscale {
		i.emitter.EmitPhase("vpn-tools", "安装内网穿透工具...", 45)
		if config.InstallZeroTier {
			if err := i.InstallVPNTool(ctx, "zerotier"); err != nil {
				i.emitter.EmitLog(fmt.Sprintf("⚠️ ZeroTier 安装失败: %v（跳过）", err))
			} else if config.ZerotierNetworkId != "" {
				// 安装成功后自动加入网络
				i.emitter.EmitLog(fmt.Sprintf("正在加入 ZeroTier 网络: %s", config.ZerotierNetworkId))
				sc := i.newSC("install", "zerotier-join")
				joinCmd := "sudo zerotier-cli join " + config.ZerotierNetworkId
				if runtime.GOOS == "windows" {
					joinCmd = "zerotier-cli join " + config.ZerotierNetworkId
				}
				if err := sc.RunShell(ctx, joinCmd); err != nil {
					i.emitter.EmitLog(fmt.Sprintf("⚠️ 加入 ZeroTier 网络失败: %v", err))
				} else {
					i.emitter.EmitLog(fmt.Sprintf("✓ 已加入 ZeroTier 网络: %s", config.ZerotierNetworkId))
				}
			}
		}
		if config.InstallTailscale {
			if err := i.InstallVPNTool(ctx, "tailscale"); err != nil {
				i.emitter.EmitLog(fmt.Sprintf("⚠️ Tailscale 安装失败: %v（跳过）", err))
			}
		}
	}

	// 阶段 2: 配置（可选）
	if !config.SkipConfig {
		i.emitter.EmitPhase("configure", "开始配置...", 50)
		if err := i.ConfigureOpenClaw(ctx, config); err != nil {
			result.ErrorMessage = "配置失败"
			result.ErrorDetails = err.Error()
			i.emitter.EmitError(result.ErrorMessage, result)
			return result, err
		}
	} else {
		i.emitter.EmitLog("跳过模型配置，生成默认配置文件...")
		if err := i.ensureDefaultConfig(); err != nil {
			i.emitter.EmitLog(fmt.Sprintf("⚠️ 生成默认配置失败: %v", err))
		}
	}

	// 阶段 3: 启动（可选）
	if !config.SkipGateway {
		i.emitter.EmitPhase("start", "启动 Gateway...", 75)
		if err := i.StartGatewayWithConfig(ctx, config); err != nil {
			result.ErrorMessage = "Gateway 启动失败"
			result.ErrorDetails = err.Error()
			i.emitter.EmitError(result.ErrorMessage, result)
			return result, err
		}
	} else {
		i.emitter.EmitLog("跳过启动 Gateway，稍后可手动启动")
	}

	// 阶段 4: 验证
	i.emitter.EmitPhase("verify", "验证安装...", 90)
	i.emitter.EmitLog("🔍 正在进行全面测试 / Running comprehensive tests...")
	doctor, err := i.RunDoctor(ctx)
	if err != nil {
		i.emitter.EmitLog(fmt.Sprintf("诊断警告: %s", err.Error()))
	}

	// 获取最终状态
	result.Success = true
	if info := detectTool("openclaw", "--version"); info.Installed {
		result.Version = info.Version
	}
	result.ConfigPath = GetOpenClawConfigPath()
	_, cfgValid, _ := checkConfigFileValid(result.ConfigPath)
	cfgConfigured := checkOpenClawConfigured(result.ConfigPath)
	gwRunning, gwPort := checkGatewayRunning()
	result.GatewayPort = gwPort

	// 收集安装详单
	var summary []InstallSummaryItem

	// — 必装依赖 —
	nodeInfo := detectNodeWithFallback()
	if nodeInfo.Installed {
		summary = append(summary, InstallSummaryItem{Label: "Node.js", Status: "ok", Detail: nodeInfo.Version, Category: "deps"})
	} else if needsRestart {
		summary = append(summary, InstallSummaryItem{Label: "Node.js", Status: "warn", Detail: "已安装，重启后生效", Category: "deps"})
	} else {
		summary = append(summary, InstallSummaryItem{Label: "Node.js", Status: "fail", Detail: "未安装", Category: "deps"})
	}

	npmInfo := detectTool("npm", "--version")
	if npmInfo.Installed {
		summary = append(summary, InstallSummaryItem{Label: "npm", Status: "ok", Detail: npmInfo.Version, Category: "deps"})
	} else {
		summary = append(summary, InstallSummaryItem{Label: "npm", Status: "warn", Detail: "未检测到", Category: "deps"})
	}

	ocInfo := detectTool("openclaw", "--version")
	if ocInfo.Installed {
		summary = append(summary, InstallSummaryItem{Label: "OpenClaw", Status: "ok", Detail: ocInfo.Version, Category: "deps"})
	} else if needsRestart {
		summary = append(summary, InstallSummaryItem{Label: "OpenClaw", Status: "warn", Detail: "已安装，重启后生效", Category: "deps"})
	} else {
		summary = append(summary, InstallSummaryItem{Label: "OpenClaw", Status: "fail", Detail: "未安装", Category: "deps"})
	}

	chInfo := detectTool("clawhub", "--version")
	if chInfo.Installed {
		summary = append(summary, InstallSummaryItem{Label: "ClawHub CLI", Status: "ok", Detail: chInfo.Version, Category: "deps"})
	} else {
		summary = append(summary, InstallSummaryItem{Label: "ClawHub CLI", Status: "warn", Detail: "未安装（可选）", Category: "deps"})
	}

	// — 选装工具 —
	if config.InstallZeroTier {
		ztInfo := detectTool("zerotier-cli", "--version")
		if ztInfo.Installed {
			detail := ztInfo.Version
			if config.ZerotierNetworkId != "" {
				detail += "  网络: " + config.ZerotierNetworkId
			}
			summary = append(summary, InstallSummaryItem{Label: "ZeroTier", Status: "ok", Detail: detail, Category: "optional"})
		} else {
			summary = append(summary, InstallSummaryItem{Label: "ZeroTier", Status: "fail", Detail: "安装失败", Category: "optional"})
		}
	}
	if config.InstallTailscale {
		tsInfo := detectTool("tailscale", "--version")
		if tsInfo.Installed {
			summary = append(summary, InstallSummaryItem{Label: "Tailscale", Status: "ok", Detail: tsInfo.Version, Category: "optional"})
		} else {
			summary = append(summary, InstallSummaryItem{Label: "Tailscale", Status: "fail", Detail: "安装失败", Category: "optional"})
		}
	}

	// — 技能运行时依赖（非致命） —
	for _, dep := range []struct{ name, flag string }{
		{"go", "--version"}, {"uv", "--version"}, {"ffmpeg", "-version"}, {"jq", "--version"}, {"rg", "--version"},
	} {
		info := detectTool(dep.name, dep.flag)
		if info.Installed {
			summary = append(summary, InstallSummaryItem{Label: dep.name, Status: "ok", Detail: info.Version, Category: "optional"})
		}
	}

	// — 配置信息 —
	summary = append(summary, InstallSummaryItem{Label: "配置文件", Status: func() string {
		if cfgValid {
			return "ok"
		}
		return "warn"
	}(), Detail: result.ConfigPath, Category: "config"})

	if cfgConfigured {
		summary = append(summary, InstallSummaryItem{Label: "模型服务商", Status: "ok", Detail: "已配置", Category: "config"})
	} else {
		summary = append(summary, InstallSummaryItem{Label: "模型服务商", Status: "warn", Detail: "未配置", Category: "config"})
	}

	// — 网关状态 —
	gwMode := "local"
	gwBind := "loopback"
	if cfgValid {
		if raw := readOpenClawConfigRaw(result.ConfigPath); raw != nil {
			if gw, ok := raw["gateway"].(map[string]interface{}); ok {
				if m, ok := gw["mode"].(string); ok {
					gwMode = m
				}
				if b, ok := gw["bind"].(string); ok {
					gwBind = b
				}
			}
		}
	}

	if gwRunning {
		summary = append(summary, InstallSummaryItem{Label: "Gateway", Status: "ok", Detail: fmt.Sprintf("运行中  端口: %d  模式: %s  绑定: %s", gwPort, gwMode, gwBind), Category: "gateway"})
	} else if config.SkipGateway {
		summary = append(summary, InstallSummaryItem{Label: "Gateway", Status: "skip", Detail: "已跳过启动", Category: "gateway"})
	} else {
		summary = append(summary, InstallSummaryItem{Label: "Gateway", Status: "warn", Detail: fmt.Sprintf("未运行  端口: %d", gwPort), Category: "gateway"})
	}

	// 发送完成事件
	var completeMsg string
	if needsRestart {
		completeMsg = "OpenClaw 安装完成！请重启应用以使环境变量生效。"
	} else if config.SkipConfig {
		completeMsg = "OpenClaw 安装完成！请稍后手动配置。"
	} else {
		completeMsg = "OpenClaw 安装完成！"
	}

	i.emitter.EmitComplete(completeMsg, map[string]interface{}{
		"version":          result.Version,
		"configPath":       result.ConfigPath,
		"port":             result.GatewayPort,
		"gatewayRunning":   gwRunning,
		"configValid":      cfgValid,
		"configConfigured": cfgConfigured,
		"doctor":           doctor,
		"needsRestart":     needsRestart,
		"skipConfig":       config.SkipConfig,
		"packageName":      config.Version,
		"summary":          summary,
	})

	return result, nil
}
