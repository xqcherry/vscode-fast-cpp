# vscode-fast-cpp

> 一键获取 MinGW、编译 / 运行 / 调试 C/C++ 的 VS Code 扩展  
> VS Code extension that boots a ready-to-run MinGW toolchain and debugger for C/C++ on Windows.

## 为什么要用它 | Why It Exists
- **零配置环境**：首次激活时自动下载官方 MinGW-w64（GCC 14.3），免去手动安装与路径配置。
- **课堂/竞赛友好**：提供中文提示、默认快捷键和一键命令，帮助初学者聚焦代码本身。
- **内置调试适配器**：自研 `xq_cppdbg` Debug Adapter，直接在 VS Code 内完成断点、单步和变量查看。

## 功能速览 | Feature Highlights
- 自动维护 `maomao.gpp` 指向的 g++ 路径，必要时重用缓存或重新下载。
- `maomao.compile`：当前 C/C++ 文件一键编译并在独立终端运行，默认 `-g -O0 -Wall`。
- `xq.debug`：编译后立即通过 `xq_cppdbg` 启动 GDB/MI 调试，支持入口暂停、断点、单步。
- `maomao.hello`：示例命令，展示通知交互流程。
- 内置键位：`Ctrl+Shift+B` 编译、`Ctrl+F6` 调试、`Ctrl+F5` Hello；可在命令面板或编辑器右键菜单触发。
- `editor/context` 菜单集成，选中文件即可快速操作。

## 快速上手 | Quick Start
1. **安装扩展**：在 VS Code Marketplace 搜索 “vscode-fast-cpp” 或从本仓库构建 VSIX。
2. **打开源文件**：加载任意 `.cpp` / `.c` 文件即触发扩展激活。
3. **首次准备 MinGW**：扩展会提示下载并解压 MinGW，等待通知完成即可。
4. **编译与运行**：执行 `maomao.compile`（命令面板、快捷键或右键）。生成的 `.exe` 会在独立终端启动并 `pause` 等待输入。
5. **断点调试**：执行 `xq.debug`。扩展会复用上一步编译产物，自动注册 Debug Adapter 并启动调试会话。

### 调试配置
`package.json` 内置 `xq_cppdbg` 调试器，默认 `launch` 配置如下：
```jsonc
{
  "name": "C++ Debugger",
  "type": "xq_cppdbg",
  "request": "launch",
  "program": "${workspaceFolder}/a.exe",
  "cwd": "${workspaceFolder}",
  "stopAtEntry": true,
  "stdinFile": "${workspaceFolder}/input.txt"
}
```
可在 `.vscode/launch.json` 中根据项目自定义 `program`、`cwd` 或输入文件。

### 可配置项 | Settings
| Setting | 描述 |
| --- | --- |
| `maomao.gpp` | g++ 绝对路径；留空时自动写入缓存的 MinGW 可执行文件。 |
| `maomao.debugInputFile` | 调试阶段重定向到程序标准输入的文本文件路径（空字符串表示禁用）。 |

## 架构概览 | Architecture
```
src/
├─ extension.ts        # VS Code 激活入口、命令注册、终端运行
├─ mingw.ts            # MinGW 下载、解压、路径拼装与 PATH 注入
└─ debug/
   └─ DebugAdapterC++.ts  # 基于 @vscode/debugadapter 的 GDB/MI 内联调试器
src/test/extension.test.ts # VS Code 集成测试
out/                    # tsc 产物（自动生成，请勿修改）
```
- `ensureMinGW()`：检测 `context.globalStorageUri/mingw/bin/x86_64-w64-mingw32-g++.exe`，缺失则下载 `7z` 包并通过 `7zip-min` 解压，进度通过 VS Code 通知展示。
- `compileFile()`：在当前编辑器文件上运行 g++，输出路径与源文件同目录，仅替换扩展名为 `.exe`。
- `DebugCPP`：实现 GDB/MI 命令发送、断点同步、堆栈/变量查询、线程事件映射，借助 `DebugAdapterInlineImplementation` 内嵌到 VS Code。

## 开发指南 | Development Workflow
1. **安装依赖**：`npm install`
2. **构建**：`npm run compile`（一次性）或 `npm run watch`（增量）
3. **代码质量**：`npm run lint`
4. **测试**：`npm test`（通过 `@vscode/test-electron` 运行集成测试，自动先跑 `compile` + `lint`）
5. **调试扩展**：在 VS Code 中使用 “Run Extension” 目标，结合 `npm run watch` 获取实时构建输出。

### 发布流程 | Release
1. 确认 `npm run compile`, `npm run lint`, `npm test` 均通过。
2. 运行 `./publish.sh` 生成 `.vsix` 包（需 Git Bash / WSL 环境）。
3. 使用 `vsce` 上传至 Marketplace，或将构建产物分享给用户手动安装。
4. PR / 发布说明中附上关键命令输出或截图，便于审查验证。

## 贡献 | Contributing
- 请遵循 TypeScript + ESLint 规则，保持现有缩进与命名约定（`maomao.*` 前缀）。
- 功能变更若影响编译、调试或文件系统逻辑，应补充/更新 `src/test` 内的集成测试。
- 提交前确保工作区干净、脚本全部通过；PR 中说明修改点、测试结果及潜在影响。

欢迎提交 issue 或 PR，持续提升 Windows 上的 C/C++ 学习与练习体验！
