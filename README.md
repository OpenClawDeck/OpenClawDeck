<div align="center">

# OpenClawDeck

**Complexity within, simplicity without.**<br>
**繁于内，简于形。**

[![Release](https://img.shields.io/badge/Release-0.0.1-blue?style=for-the-badge&logo=rocket)](https://github.com/OpenClawDeck/OpenClawDeck/releases)
[![Build](https://img.shields.io/badge/Build-Passing-success?style=for-the-badge&logo=github-actions)](https://github.com/OpenClawDeck/OpenClawDeck/actions)
[![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](LICENSE)

---

**OpenClawDeck** is an open-source web control panel built for [OpenClaw](https://github.com/openclaw/openclaw). It transforms complex AI agent management into an elegant, intuitive visual experience.

**OpenClawDeck** 是专为 [OpenClaw](https://github.com/openclaw/openclaw) 打造的开源 Web 控制面板。将复杂的 AI 智能体管理，转化为优雅直观的视觉体验。

</div>

> [!CAUTION]
> **Beta Preview** — This is an early preview release. It has not undergone comprehensive testing. **Do not use in production environments.**
>
> **Beta 预览版** — 当前为初始预览版本，尚未进行深度完整的覆盖测试，**请勿用于生产环境。**

<br>

## ✨ Why OpenClawDeck?

### macOS-Grade Visual Experience | macOS 级视觉体验

The interface faithfully recreates the macOS design language — refined glassmorphism, rounded cards, and smooth animation transitions. Managing AI agents feels as natural as using a native desktop app.

界面高度还原 macOS 设计语言，采用精致的毛玻璃效果、圆角卡片和细腻的动画过渡，让管理 AI 智能体像操作原生桌面应用一样流畅自然。

### Beginner-Friendly Setup | 新用户极友好

Guided wizards and pre-built templates let you complete OpenClaw's initial configuration and model setup without memorizing a single command.

图形化引导和预设模板，让你无需记忆复杂命令，即可快速完成 OpenClaw 的初始配置与模型接入。

### Deep Configuration | 深度配置能力

Fine-tune every OpenClaw parameter — model switching, memory management, plugin loading, channel routing — all through a beautiful visual editor.

支持对 OpenClaw 底层参数进行精细调控，包括模型切换、记忆管理、插件加载、频道路由等，满足高级用户的定制化需求。

### Real-Time Observability | 全景观测系统

Built-in monitoring dashboard with live execution status, resource consumption, and task history — full visibility into every agent's behavior.

内置实时监控仪表盘，直观展示 AI 的执行状态、资源消耗和任务历史，让你对智能体的运行了如指掌。

### Cross-Platform | 全平台支持

Single binary, zero dependencies. Runs natively on Windows, macOS (Intel & Apple Silicon), and Linux (amd64 & arm64). Download and run — that's it.

单文件零依赖，原生支持 Windows、macOS（Intel 与 Apple Silicon）和 Linux（amd64 与 arm64）。下载即用，开箱即跑。

### Responsive & Mobile-Ready | 屏幕自适应与移动端适配

Fully responsive layout that adapts seamlessly from large desktop monitors to tablets and mobile phones. Manage your AI agents on the go — no compromise on functionality.

完整的响应式布局，从大屏桌面到平板和手机无缝适配。随时随地管理你的 AI 智能体，功能体验零妥协。

### Multilingual Support | 多语言支持

Full i18n architecture with built-in English and Chinese. Adding a new language is as simple as dropping in a JSON file — no code changes required.

完整的国际化架构，内置中英双语支持。新增语言只需添加一个 JSON 文件，无需修改任何代码。

### Local & Remote Gateway | 本地与远程网关

Seamlessly manage both local and remote OpenClaw gateways. Switch between gateway profiles with one click — perfect for multi-environment setups like dev, staging, and production.

同时支持本地网关与远程网关管理。一键切换网关配置档案，轻松应对开发、测试、生产等多环境部署场景。

<br>

## 🚀 Quick Start

### One-Click Install | 一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/OpenClawDeck/OpenClawDeck/main/install.sh | bash
```

### Manual Download | 手动下载

Download the binary from [Releases](https://github.com/OpenClawDeck/OpenClawDeck/releases). No dependencies. Just run.

从 [Releases](https://github.com/OpenClawDeck/OpenClawDeck/releases) 下载二进制文件，零依赖，直接运行。

```bash
# Run with default settings / 使用默认配置启动 (localhost:18791)
./openclawdeck

# Specify port and bind address / 指定端口和绑定地址
./openclawdeck --port 18791 --bind 0.0.0.0

# Create initial admin user on first run / 首次运行时创建管理员账户
./openclawdeck --user admin --pass your_password

# All options combined / 组合使用所有参数
./openclawdeck --bind 0.0.0.0 --port 18791 --user admin --pass your_password
```

| Flag | Short | Description | 说明 |
| :--- | :---: | :--- | :--- |
| `--port` | `-p` | Server port (default: `18791`) | 服务端口（默认 `18791`） |
| `--bind` | `-b` | Bind address (default: `127.0.0.1`) | 绑定地址（默认 `127.0.0.1`） |
| `--user` | `-u` | Initial admin username (first run only) | 初始管理员用户名（仅首次） |
| `--pass` | | Initial admin password (min 6 chars) | 初始管理员密码（至少 6 位） |
| `--debug` | | Enable debug logging | 启用调试日志 |

<br>

## ✨ Features

| | Feature | Description | 说明 |
| :---: | :--- | :--- | :--- |
| 💎 | **Pixel-Perfect UI** | Native macOS feel with glassmorphism, smooth animations, dark/light themes | macOS 级视觉体验，毛玻璃效果、流畅动画、明暗主题 |
| 🎛️ | **Gateway Control** | Start, stop, restart your Gateway instantly with real-time health monitoring | 一键启停网关，实时健康监控 |
| 🖼 | **Visual Config Editor** | Edit configurations and agent profiles without touching JSON/YAML | 可视化配置编辑器，告别手写 JSON/YAML |
| 🧙 | **Setup Wizard** | Step-by-step guided setup for first-time users | 新手引导向导，逐步完成配置 |
| 🧩 | **Template Center** | Deploy new agent personas in seconds with built-in templates | 模板中心，秒级部署新代理人设 |
| 📊 | **Live Dashboard** | Real-time metrics, session tracking, and activity monitoring | 实时仪表盘，会话追踪与活动监控 |
| 🛡️ | **Security Built-in** | JWT auth, HttpOnly cookies, and alert system from day one | 内置安全体系：JWT 认证、HttpOnly Cookie、告警系统 |
| 🌍 | **i18n Ready** | Full English and Chinese support, easily extensible | 完整国际化，内置中英双语，轻松扩展 |
| 📱 | **Responsive Design** | Works seamlessly on desktop and mobile | 响应式设计，桌面与移动端无缝适配 |

<br>

## 🛠️ Tech Stack | 技术栈

| Layer | Technology | 说明 |
| :--- | :--- | :--- |
| **Backend** | Go (Golang) | 单文件编译，零外部依赖 |
| **Frontend** | React + TailwindCSS | 响应式、主题感知 UI |
| **Database** | SQLite / PostgreSQL | 默认 SQLite，可选 PostgreSQL |
| **Real-time** | WebSocket + SSE | 实时双向通信 |
| **Deployment** | Single binary, cross-platform | 单文件跨平台（Windows / macOS / Linux） |

<br>

## 💬 A Note from the Author | 作者寄语

This is my first open-source project, built almost entirely with the help of AI. There are certainly rough edges, bugs, and things that could be done better. If you find any issues or have suggestions, please don't hesitate to open an [Issue](https://github.com/OpenClawDeck/OpenClawDeck/issues) or submit a [Pull Request](https://github.com/OpenClawDeck/OpenClawDeck/pulls). Your patience, feedback, and contributions mean the world to me.

这是我的第一个开源项目，几乎完全借助 AI 完成开发。项目中难免存在不足和 Bug，如果你发现任何问题或有改进建议，欢迎提交 [Issue](https://github.com/OpenClawDeck/OpenClawDeck/issues) 或 [Pull Request](https://github.com/OpenClawDeck/OpenClawDeck/pulls)。感谢你的包涵与指教，每一份反馈都是我前进的动力。

<br>

## 📄 License | 开源协议

This project is licensed under the [MIT License](LICENSE) — free to use, modify, and distribute for both personal and commercial purposes.

本项目基于 [MIT 协议](LICENSE) 开源 — 可自由使用、修改和分发，适用于个人及商业用途。

<br>

<div align="center">
  <sub>Designed with ❤️ by OpenClawDeck</sub>
</div>
