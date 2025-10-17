import { DebugSession, InitializedEvent, TerminatedEvent, OutputEvent } from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import * as fs from 'fs';
import * as path from 'path';
// npm install --save-dev @vscode/debugadapter @vscode/debugprotocol
import * as child_process from 'child_process';

export class DebugCPP extends DebugSession {
    private gdb?: child_process.ChildProcess;

    public constructor() {
        super();
    }

    // 初始化调试
    protected initializeRequest(response:DebugProtocol.InitializeResponse): void {
        response.body = response.body || {};
        response.body.supportsConfigurationDoneRequest = true;
        this.sendResponse(response);
        this.sendEvent(new InitializedEvent());
    }
    // 启动 GDB
    protected launchRequest(response: DebugProtocol.LaunchResponse, args: any): void {
        const program = args.program;
        const cwd = args.cwd || path.dirname(program);

        if (!fs.existsSync(program)) {
            this.sendEvent(new OutputEvent(`Not Found: ${program}\n`));
            this.sendResponse(response);
            return;
        }
        // 命令行GDB调试
        const gdbcmd = `gdb "${program}"`;
        this.gdb = child_process.spawn("cmd.exe", ["/c", "start", '""', "/WAIT", "cmd", "/k", gdbcmd], {
            cwd,
            detached: true,
            shell: false,
        });
        this.gdb.on("exit", () => {
            this.sendEvent(new OutputEvent(`[External GDB closed]\n`));
            this.sendEvent(new TerminatedEvent());
        });
        
        this.sendEvent(new OutputEvent(`[Launch] Opened new GDB console for ${program}\n`));
        this.sendResponse(response);
    }
    // 停止调试
    protected disconnectRequest(response: DebugProtocol.DisconnectResponse): void {
        this.gdb?.kill();
        this.sendResponse(response);
    }
}