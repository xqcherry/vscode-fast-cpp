import { DebugSession, InitializedEvent, TerminatedEvent, OutputEvent } from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
// npm install --save-dev @vscode/debugadapter @vscode/debugprotocol
import * as child_process from 'child_process';
import { text } from 'stream/consumers';

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
        const cwd = args.cwd || program.cwd();

        this.gdb = child_process.spawn("gdb", ["--interpreter=mi"], {cwd});

        this.gdb.stdout?.on("data", data => {
            const text = data.toString();
            this.sendEvent(new OutputEvent(`[GDB] ${text}`));
        });
        this.gdb.stderr?.on("data", data => {
            const text = data.toString();
            this.sendEvent(new OutputEvent(`[GDB-ERR] ${text}`));
        });
        this.gdb.on("exit", () => {
            this.sendEvent(new TerminatedEvent());
        });

        // 加载要调试的程序（不能只启动不加载啊www...）
        this.gdb.stdin?.write(`-file-exec-and-symbols "${program}"\n`);
        this.gdb.stdin?.write(`-gdb-set pagination off\n`);
        this.gdb.stdin?.write(`-exec-run\n`);
        
        this.sendResponse(response);
    }
    // 停止调试
    protected disconnectRequest(response: DebugProtocol.DisconnectResponse): void {
        this.gdb?.kill();
        this.sendResponse(response);
    }
}