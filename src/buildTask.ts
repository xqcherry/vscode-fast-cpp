import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';


export async function ensureDefaultBuildTask() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;

    const tasksJson = path.join(folder.uri.fsPath, '.vscode', 'tasks.json');
    const task = {
        version: '2.0.0',
        tasks: [
            {
                label: 'cpp: build',
                type: 'shell',
                command: '${config:maomao.gpp}',
                args: ['-std=c++17', '-Wall', '-g', '${file}', '-o', '${fileDirname}\\${fileBasenameNoExtension}.exe'],
                group: { kind: 'build', isDefault: true },
                problemMatcher: ['$gcc'],
                detail: 'MinGW 编译当前文件'
            }
        ]
    };


    let content = task;
    if (fs.existsSync(tasksJson)) {
        try {
            const old = JSON.parse(fs.readFileSync(tasksJson, 'utf8'));

            const idx = old.tasks.findIndex((t: any) => t.label === 'cpp: build');
            if (idx >= 0) old.tasks[idx] = task.tasks[0];
            else old.tasks.push(task.tasks[0]);
            content = old;
        } catch {}
    } else {
        fs.mkdirSync(path.dirname(tasksJson), { recursive: true });
    }
    fs.writeFileSync(tasksJson, JSON.stringify(content, null, 4));
}