# vscode-fast-cpp

## 项目简介 | Overview
`vscode-fast-cpp` 是一款面向 Windows 的 VS Code 扩展，帮助开发者在无需手动部署编译环境的情况下快速编译、运行和调试 C/C++ 程序。扩展会在首次启动时自动下载并缓存 MinGW 工具链，提供一键编译命令、内置调试适配器，以及带有中文提示的操作流程，适合教学、竞赛和日常练习场景。

## 主要功能 | Features
- **自动准备 MinGW**：通过 `maomao.gpp` 配置项管理 g++ 路径，缺失时自动下载并解压官方 MinGW 发行版。
- **一键编译与运行**：`maomao.compile` 命令支持在当前文件目录调用 g++，并以独立终端窗口运行生成的可执行文件。
- **内联调试适配器**：`xq_cppdbg` Debug Adapter 基于 VS Code Inline API 提供断点调试、入口暂停等能力。
- **便捷命令和快捷键**：默认绑定 `Ctrl+Shift+B` 编译、`Ctrl+F6` 调试、`Ctrl+F5` 显示问候信息，可在命令面板和编辑器右键菜单中调用。

## 使用指引 | Getting Started
1. 在 VS Code 中安装扩展后打开任意 `.cpp` 或 `.c` 文件。
2. 首次使用会提示下载 MinGW，按通知指引完成安装后即可开始编译。
3. 使用命令面板或快捷键执行 `maomao.compile` 生成可执行文件，终端窗口会自动弹出并暂停查看输出。
4. 选择 `xq.debug` 命令触发调试，会在同一路径下先行编译并启动 `xq_cppdbg` 调试会话。

### 可配置项
- `maomao.gpp`：自定义 g++ 绝对路径，若留空将使用扩展缓存的 MinGW 版本。

## 开发者指南 | Development
- 源码位于 `src/`，入口 `src/extension.ts`，MinGW 下载逻辑在 `src/mingw.ts`，调试适配器在 `src/debug/`，集成测试在 `src/test/`。
- 编译流程：`npm install` → `npm run compile`，持续开发可使用 `npm run watch`。
- 质量检查：运行 `npm run lint` 触发 ESLint；执行 `npm test` 运行 VS Code 集成测试（Mocha）。
- 推荐在 VS Code 中加载本仓库，使用 “Run Extension” 启动目标进行调试，加速调试适配器迭代。

```
.
├─ src/
│  ├─ extension.ts       # 扩展激活、命令注册与调试入口
│  ├─ mingw.ts           # MinGW 下载、解压与路径管理
│  └─ debug/             # C++ Debug Adapter 实现
├─ src/test/             # 集成测试与夹具
├─ out/                  # TypeScript 转译产物（自动生成）
└─ publish.sh            # 打包 VSIX 辅助脚本
```

## 测试与发布 | Testing & Release
- 在提交前确保通过 `npm run lint` 与 `npm test`，避免回归。
- 发布前运行 `npm run compile`，确认 `out/` 产物最新，随后执行 `./publish.sh` 生成 `.vsix` 包或配合 `vsce` 发布到 Marketplace。
- 建议在 PR 或发布说明中附带关键命令的终端输出或截图，便于审查者快速验证行为。
