import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/** 确保存在「默认生成任务」json，让 Ctrl+Shift+B 直接可用 */
export async function ensureDefaultBuildTask() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;                  // 无打开文件夹

    const tasksJson = path.join(folder.uri.fsPath, '.vscode', 'tasks.json');
    const task = {
        version: '2.0.0',
        tasks: [
            {
                label: 'cpp: build',
                type: 'shell',
                command: '${config:maomao.gpp}', // 用配置项存 g++ 路径
                args: ['-std=c++17', '-Wall', '-g', '${file}', '-o', '${fileDirname}\\${fileBasenameNoExtension}.exe'],
                group: { kind: 'build', isDefault: true },
                problemMatcher: ['$gcc'],
                detail: 'MinGW 编译当前文件'
            }
        ]
    };

    // 若已存在则合并/更新，否则新建
    let content = task;
    if (fs.existsSync(tasksJson)) {
        try {
            const old = JSON.parse(fs.readFileSync(tasksJson, 'utf8'));
            // 保留旧任务，只更新/追加我们的
            const idx = old.tasks.findIndex((t: any) => t.label === 'cpp: build');
            if (idx >= 0) old.tasks[idx] = task.tasks[0];
            else old.tasks.push(task.tasks[0]);
            content = old;
        } catch { /* 解析失败直接覆盖 */ }
    } else {
        fs.mkdirSync(path.dirname(tasksJson), { recursive: true });
    }
    fs.writeFileSync(tasksJson, JSON.stringify(content, null, 4));
}