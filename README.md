# vscode-fast-cpp

一个面向 Windows 的 VS Code C/C++ 扩展：
- 首次自动下载并安装 MinGW（WinLibs）
- 一键编译当前 C/C++ 文件
- 内置 GDB/MI 调试适配器进行断点调试

## 功能概览

### 1) 自动准备 MinGW 工具链
扩展激活后会执行工具链检查：
- 若本地未找到可用 `g++` / `gdb`，自动下载最新 WinLibs Release 并解压
- 自动写入全局设置：`maomao.gpp`、`maomao.gdb`
- 自动将 MinGW `bin` 目录注入当前扩展进程的 `PATH`

> 下载支持代理前缀回退，适合网络环境不稳定时使用。

### 2) 编译当前文件（`maomao.compile`）
支持 `.c` / `.cpp` 文件，编译参数固定为：
- `-g -O0 -Wall -Wl,--disable-dynamicbase`

输出规则：
- 在源文件同级目录创建 `output/`
- 生成 `${文件名}.exe`（例如 `main.cpp -> output/main.exe`）

编译成功后会在名为 `MinGW Run` 的终端中启动程序并保留窗口。

### 3) 一键启动调试（`xq.debug`）
`xq.debug` 会先编译，再启动内置调试器类型 `xq_cppdbg`：
- 基于 GDB/MI 协议
- 支持断点、继续、暂停、单步、堆栈、变量查看
- 支持中文路径/非 ASCII 路径的调试兜底处理（自动复制到临时目录调试）
- 对源码映射做了路径修复（`set substitute-path`）

### 4) 示例命令（`maomao.hello`）
用于验证扩展命令是否正常注册。

---

## 快速使用

1. 安装扩展并打开一个包含 `.c` 或 `.cpp` 的工作区
2. 首次激活时等待 MinGW 自动下载/解压完成
3. 使用以下任一方式运行命令：
   - 命令面板（`Ctrl+Shift+P`）
   - 编辑器右键菜单
   - 快捷键

默认快捷键：
- `Ctrl+Shift+B` → `maomao.compile`
- `Ctrl+F6` → `xq.debug`
- `Ctrl+F5` → `maomao.hello`

---

## 扩展设置（Settings）

在 VS Code 设置中搜索 `maomao`：

- `maomao.gpp`：`g++` 绝对路径（通常由扩展自动填充）
- `maomao.gdb`：`gdb` 绝对路径（通常由扩展自动填充）
- `maomao.downloadProxy.enabled`：是否启用下载代理前缀回退（默认 `true`）
- `maomao.downloadProxy.prefixes`：代理前缀数组（按顺序尝试）

默认代理前缀：
- `https://ghfast.top/`
- `https://gh-proxy.com/`
- `https://mirror.ghproxy.com/`

---

## 调试器类型

本扩展贡献了调试器类型：`xq_cppdbg`

可在 `launch.json` 中使用（最小示例）：

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "C++ Debugger",
      "type": "xq_cppdbg",
      "request": "launch",
      "program": "${workspaceFolder}/a.exe",
      "cwd": "${workspaceFolder}",
      "stopAtEntry": true
    }
  ]
}
```

> 日常使用中，直接执行 `xq.debug` 即可自动编译并启动调试，一般不需要手写配置。

---

## 项目结构（src）

- `src/extension.ts`：扩展入口，注册命令与内联调试适配器
- `src/mingw.ts`：MinGW 下载、解压、自动发现与路径同步
- `src/debug/DebugAdapterC++.ts`：调试会话主类
- `src/debug/gdbController.ts`：GDB 进程管理与 MI 命令收发
- `src/debug/miParser.ts`：GDB/MI 输出解析器
- `src/debug/sourceResolver.ts`：源码路径映射与 substitute-path 处理
- `src/debug/sessionState.ts`：调试状态管理
- `src/debug/handlers/*.ts`：按请求类型拆分的调试处理逻辑（launch/control/breakpoints/stackTrace/variables）
- `src/buildTask.ts`：生成/更新默认构建任务（当前入口未调用）

---

## 本地开发

```bash
npm install
npm run compile
npm run watch
npm run lint
npm test
```

脚本说明：
- `compile`：TypeScript 编译
- `watch`：监听模式编译
- `lint`：ESLint 检查 `src`
- `test`：VS Code 扩展测试（会先执行 `compile` 与 `lint`）

---

## 说明

- 当前实现主要面向 **Windows + MinGW** 使用场景。
- 扩展目标是让 C/C++ 初学者在 VS Code 中尽量“开箱即用”。
