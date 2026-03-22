import * as cp from 'child_process';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ensureMinGW, MinGWToolchain } from './mingw';
import { DebugCPP } from './debug/DebugAdapterC++';


async function compileFile(gppPath: string): Promise<string | null> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('没有活动编辑器，无法编译。');
        return null;
    }

    const doc = editor.document;
    if (doc.languageId !== 'cpp' && doc.languageId !== 'c') {
        vscode.window.showWarningMessage('当前文件不是 C/C++ 源码。');
        return null;
    }

    const src = doc.fileName;
    const exe = src.replace(/\.(cpp|c)$/i, '.exe');

    try {
        const args = ['-g', '-O0', '-Wall', '-Wl,--disable-dynamicbase', src, '-o', exe];

        if (!fs.existsSync(gppPath)) {
            vscode.window.showErrorMessage(`编译失败: g++ 路径异常，请检查: ${gppPath}`);
            return null;
        }
        if (!fs.existsSync(src)) {
            vscode.window.showErrorMessage(`编译失败: 源文件路径异常，请检查: ${src}`);
            return null;
        }

        cp.execFileSync(gppPath, args, {
            cwd: path.dirname(src),
            encoding: 'utf8',
        });

        vscode.window.showInformationMessage(`编译成功：${path.basename(exe)}`);
        return exe;
    } catch (err: any) {
        console.error('[g++ stderr]\n' + (err.stderr?.toString() || err.message));
        vscode.window.showErrorMessage('编译失败，请查看开发者工具控制台输出。');
        return null;
    }
}


export async function activate(context: vscode.ExtensionContext) {
    let toolchain: MinGWToolchain;

    try {
        toolchain = await ensureMinGW(context);
    } catch (err: any) {
        vscode.window.showErrorMessage(`MinGW 初始化失败: ${err?.message || String(err)}`);
        return;
    }

    console.log('[MinGW] g++:', toolchain.gppPath);
    console.log('[MinGW] gdb:', toolchain.gdbPath);

    const compile = vscode.commands.registerCommand('maomao.compile', async () => {
        const exe = await compileFile(toolchain.gppPath);
        if (!exe) {
            return;
        }

        const terminalName = 'MinGW Run';
        let terminal = vscode.window.terminals.find((t) => t.name === terminalName);
        if (!terminal) {
            terminal = vscode.window.createTerminal(terminalName);
        }

        terminal.show();
        terminal.sendText(`cmd /c start /wait cmd /c ""${exe}" & pause"`);
    });

    const hello = vscode.commands.registerCommand('maomao.hello', async () => {
        vscode.window.showInformationMessage('你好，测试！');
    });

    const debug = vscode.commands.registerCommand('xq.debug', async () => {
        const exe = await compileFile(toolchain.gppPath);
        if (!exe) {
            return;
        }

        const cwd = path.dirname(exe);
        const config: vscode.DebugConfiguration = {
            type: 'xq_cppdbg',
            name: 'C++ Debugger',
            request: 'launch',
            program: exe,
            cwd,
            stopAtEntry: true,
            gdbPath: toolchain.gdbPath,
        };

        await vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], config);
    });

    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory('xq_cppdbg', {
            createDebugAdapterDescriptor: (_session) => {
                return new vscode.DebugAdapterInlineImplementation(new DebugCPP(toolchain.gdbPath));
            },
        })
    );

    context.subscriptions.push(compile, hello, debug);
}
