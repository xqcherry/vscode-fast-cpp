import * as cp from 'child_process';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ensureMinGW } from './mingw';
import { DebugCPP } from './debug/DebugAdapterC++';

export async function activate(context: vscode.ExtensionContext) {
	const gpp = await ensureMinGW(context);
	console.log('[MinGW] g++:', gpp);

	// 编译命令
	const compile = vscode.commands.registerCommand('maomao.compile', async () => {
		console.log('[compile] 命令被触发');
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;
		const doc = editor.document;
		if (doc.languageId !== 'cpp' && doc.languageId !== 'c') return;
		vscode.window.showInformationMessage(`启动compile！`);
		const src = doc.fileName;
		const exe = src.replace(/\.(cpp|c)$/, '.exe');

		try {
			const args = ['-static', '-static-libgcc', '-static-libstdc++', src, '-o', exe];
			console.log('是否存在：', fs.existsSync(gpp));
			console.log(`Executing: g++ ${args.join(' ')}`);
			console.log('是否存在：', fs.existsSync(src));
			if (!fs.existsSync(gpp)) {
				vscode.window.showErrorMessage('编译失败:g++路径异常，请查看' + gpp);
				return;
			}
			if (!fs.existsSync(src)) {
				vscode.window.showErrorMessage('编译失败:本地文件路径异常，请查看' + src);
				return;
			}
			try {
				// 改为静默编译，结果只通过管道捕获
				const out = cp.execFileSync(gpp, args, { cwd: path.dirname(src), encoding: 'utf8' });
				if (out) console.log('[g++ stdout]\n' + out);
			} catch (err: any) {
				// 关键：把 g++ 的原始报错打到 VS Code Output 面板
				console.error('[g++ stderr]\n' + (err.stderr?.toString() || err.stdout?.toString() || err.message));
				vscode.window.showErrorMessage('编译失败，请查看“输出”面板');
				return;
			}

			vscode.window.showInformationMessage(`编译成功：${path.basename(exe)}`);

			const terminalName = 'MinGW Run';
			let terminal = vscode.window.terminals.find(t => t.name === terminalName);

			if (!terminal) {
				terminal = vscode.window.createTerminal(terminalName);
			}

			terminal.show();
			terminal.sendText(`cmd /c start /wait cmd /c ""${exe}" & pause"`);
		} catch (e: any) {
			vscode.window.showErrorMessage('编译失败：' + e.message);
		}
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
		const editor = vscode.window.activeTextEditor;
		if(!editor) return ;

		const exe = editor.document.fileName.replace(/\.(cpp|c)$/, '.exe');
		const cwd = path.dirname(editor.document.fileName);

		if (!fs.existsSync(exe)) {
        	vscode.window.showErrorMessage('请先编译项目再调试');
        	return;
    	}

		const config: vscode.DebugConfiguration = {
			type: 'cppdbg',
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
