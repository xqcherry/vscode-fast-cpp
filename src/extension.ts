import * as cp from 'child_process';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ensureMinGW } from './mingw';
import { DebugCPP } from './debug/DebugAdapterC++';

// 可调用的编译函数
async function compileFile(gpp: string): Promise<string | null> {
	const editor = vscode.window.activeTextEditor;
	if(!editor) return null;

	const doc = editor.document;
	if(doc.languageId !== 'cpp' && doc.languageId !== 'c') return null;

	vscode.window.showInformationMessage(`启动compile!`);
	const src = doc.fileName;
	const exe = src.replace(/\.(cpp|c)$/, '.exe');

	try {
		const args = ['-g', '-O0', '-Wall', '-Wl,--disable-dynamicbase', src, '-o', exe];
		console.log(`[compile] g++ ${args.join(' ')}`);
		console.log('是否存在：', fs.existsSync(gpp));
		console.log('是否存在：', fs.existsSync(src));

		if (!fs.existsSync(gpp)) {
			vscode.window.showErrorMessage('编译失败: g++ 路径异常, 请查看' + gpp);
			return null;
		}
		if (!fs.existsSync(src)) {
			vscode.window.showErrorMessage('编译失败:本地文件路径异常，请查看' + src);
			return null;
		}

		// 静默编译
        cp.execFileSync(gpp, args, {
            cwd: path.dirname(src),
            encoding: 'utf8',
        });

		vscode.window.showInformationMessage(`编译成功：${path.basename(exe)}`);
        return exe;
	} catch (err: any) {
        console.error('[g++ stderr]\n' + (err.stderr?.toString() || err.message));
        vscode.window.showErrorMessage('编译失败，请查看“输出”面板');
        return null;
    }
}

export async function activate(context: vscode.ExtensionContext) {
	const gpp = await ensureMinGW(context);
	console.log('[MinGW] g++:', gpp);

	const compile = vscode.commands.registerCommand('maomao.compile', async() => {
		const exe = await compileFile(gpp);
		if(!exe) return ;

		const terminalName = 'MinGW Run';
		let terminal = vscode.window.terminals.find(t => t.name === terminalName);
		if(!terminal) terminal = vscode.window.createTerminal(terminalName);

		terminal.show();
		terminal.sendText(`cmd /c start /wait cmd /c ""${exe}" & pause"`);
	});	
	
	// hello命令
	const hello = vscode.commands.registerCommand('maomao.hello', async () => {
		vscode.window.showInformationMessage(`你好，测试！`);
	});

	// 调试适配器启动函数
	context.subscriptions.push (
		vscode.debug.registerDebugAdapterDescriptorFactory('xq_cppdbg', {
			createDebugAdapterDescriptor: (_session) => {
				return new vscode.DebugAdapterInlineImplementation(new DebugCPP());
			}
		})
	)
	vscode.window.showInformationMessage('C++ Debug Adapter 注册成功!');

	// debug命令
	const debug = vscode.commands.registerCommand('xq.debug', async() => {
		const exe = await compileFile(gpp);
		if(!exe) return ;
		
		const cwd = path.dirname(exe);
		const config: vscode.DebugConfiguration = {
			type: 'xq_cppdbg',
        	name: 'C++ Debugger',
        	request: 'launch',
        	program: exe,
        	cwd: cwd,
        	stopAtEntry: true
		};
		 vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], config);
	});

	context.subscriptions.push(compile, hello, debug);
}
