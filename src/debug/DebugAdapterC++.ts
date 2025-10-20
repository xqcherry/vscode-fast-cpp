import { DebugSession, InitializedEvent, ThreadEvent, OutputEvent, StoppedEvent, TerminatedEvent} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import { t } from 'tar';
// npm install --save-dev @vscode/debugadapter @vscode/debugprotocol

// 控制GDB进程
class GDBController {
    private process?: child_process.ChildProcess;
    private buffer = '';
    private token = 1;
    private pending = new Map<number, { // 存储所有已发送但还未收到响应的命令
        resolve: (r: any) => void,
        reject: (e: any) => void,
        timeout: NodeJS.Timeout
    }>();
    private onCallBack?: (type: string, payload: string) => void;

    private onData(chunk : string) {
        this.buffer += chunk;
        let idx: number;
        while((idx = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, idx).trim();
            this.buffer = this.buffer.slice(idx + 1);
            if (line.length === 0) continue;
            this.handleLine(line);
        }
    }

    private handleLine(line : string) { // MI2 协议解析器
        const m = line.match(/^(\d+)?(\^|=|\*|~|&|@)(.*)$/s);
        if(!m) {
            this.onCallBack?.('console', line);
            return ;
        }

        const token = m[1] ? parseInt(m[1], 10) : null; 
        const prefix = m[2];
        const rest = m[3];

        if(prefix === '^') { // 命令响应
            if(token !== null && this.pending.has(token)) {
                const p = this.pending.get(token)!;
                clearTimeout(p.timeout);
                p.resolve({
                    raw: rest
                });
                this.pending.delete(token);
            }
            else {
                this.onCallBack?.('response', rest);
            }
        }
        else if(prefix === '*') { // 异步状态
            this.onCallBack?.('async', rest);
        }
        else if(prefix === '=') { // 通知事件
            this.onCallBack?.('notify', rest);
        }
        else if(prefix === '~' || prefix === '&' || prefix === '@') { // 流输出
            let s = rest;
            if (s.startsWith('"') && s.endsWith('"')) {
                try { s = JSON.parse(s); } catch {}
            }
            this.onCallBack?.('stream', s);
        }
        else {
            this.onCallBack?.('unknown', line);
        }
    } 

    start(cwd?: string) {
        if(this.process) return ;
        this.process = child_process.spawn('gdb', ['--interpreter=mi2'], {
            cwd,
            shell: false
        });
        this.process.stdout?.on('data', (d : Buffer) => this.onData(d.toString()));
        this.process.stderr?.on('data', (d : Buffer) => this.onData('(stderr)' + d.toString()));
        this.process.on('exit', () => {
            for(const [, val] of this.pending) {
                clearTimeout(val.timeout);
                val.reject(new Error(`GDB已退出`));
            }
            this.pending.clear();
        });
    }

    stop() {
        if(!this.process) return ;
        try {
            this.process.kill();
        } catch {}
        this.process = undefined;
    }

    isRunning() {
        return Boolean(this.process);
    }

    setCallBack(cb : (type: string, payload: string) => void) {
        this.onCallBack = cb;
    }

    sendCommand(cmd: string, timeoutMs = 5000): Promise<any> {
        if(!this.process || !this.process.stdin) {
            return Promise.reject(new Error(`GDB停止运行!`));
        }

        const token = this.token ++;
        const full = `${token}${cmd}\n`;
        return new Promise((resolve, reject) => {
            const to = setTimeout(() => {
                this.pending.delete(token);
                reject(new Error(`GDB命令超时` + cmd));
            }, timeoutMs);
            this.pending.set(token, {
                resolve: resolve,
                reject: reject,
                timeout: to
            });
            this.process!.stdin!.write(full);
        });
    }
}

export class DebugCPP extends DebugSession {
    private gdb = new GDBController();
    private cwd = '';
    private programPath = '';
    private breakpoints = new Map<string, Array<{ line: number, id?: number }>>();

    public constructor() {
        super();
    }

    // 初始化调试
    protected initializeRequest(response:DebugProtocol.InitializeResponse): void {
        response.body = {
            supportsConfigurationDoneRequest: true,
        };
        this.sendResponse(response);
        this.sendEvent(new InitializedEvent());
    }
    // 发送请求
    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: any): Promise<void> {
        try {
            this.programPath = args.program;
            this.cwd = args.cws || path.dirname(this.programPath);

            if (!this.programPath || !fs.existsSync(this.programPath)) {
                this.sendEvent(new OutputEvent(`未找到可执行文件: ${this.programPath}\n`));
                this.sendResponse(response);
                return;
            }

            this.gdb.start(this.cwd); // 启动gdb
            this.gdb.setCallBack((type: string, payload: string) => { // 监听gdb解析并发送给vscode
                switch(type) {
                    case 'stream':
                        this.sendEvent(new OutputEvent(payload + '\n'));
                        break;
                    case 'async':
                        if(payload.startsWith('stopped')) {
                            this.sendEvent(new StoppedEvent('breakpoint', 1));
                        }
                        break;
                    case 'notify':
                        if(payload.startsWith('thread-created')) {
                            this.sendEvent(new ThreadEvent('started', 1));
                        }
                        break;
                }
            });
            // 初始会话
            await this.gdb.sendCommand(`-file-exec-and-symbols "${this.programPath}"`);// 指定要调试的可执行文件路径
            await this.gdb.sendCommand(`-gdb-set mi-async on`); // 启用GDB/MI的异步模式

            if (args.stopOnEntry) {
                await this.gdb.sendCommand(`-exec-run --start`); // true则在main函数暂停
            }

            this.sendEvent(new OutputEvent(`[Launch] GBD-MI started for ${this.programPath}\n`));
            this.sendResponse(response);
        } catch(err) {
            this.sendEvent(new OutputEvent(`[Launch Error] ${err}\n`));
            this.sendResponse(response);
        }
    }

    protected disconnectRequest(response: DebugProtocol.DisconnectResponse): void {
        if(this.gdb.isRunning()) {
            this.gdb.sendCommand('-gdb-exit');
            this.gdb.stop();
        }
        this.sendResponse(response);
        this.sendEvent(new TerminatedEvent());
    }

    // 接下来实现map
    // DAP <--> GDB-MI
    protected async setBreakPointsRequest(
        response: DebugProtocol.SetBreakpointsResponse,
        args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
        
        const source = args.source.path || args.source.name || '<unknown>';
        this.breakpoints.set(source, []);

        const outbps : DebugProtocol.Breakpoint[] = [];
        for(const bp of args.breakpoints || []) {
            try {
                const line = bp.line;
                await this.gdb.sendCommand(`-break-insert ${line}`);

                this.breakpoints.get(source)!.push({line});
                outbps.push({
                    verified: true,
                    line: line,
                } as DebugProtocol.Breakpoint);
            } catch(err) {
                outbps.push({
                    verified: false,
                    line: bp.line,
                } as DebugProtocol.Breakpoint)
            }
        }
        response.body = {breakpoints: outbps};
        this.sendResponse(response);
    }

    protected async continueRequest(response: DebugProtocol.ContinueResponse,): Promise<void> {
        try {
            await this.gdb.sendCommand(`-exec-continue`);
            this.sendResponse(response);
        } catch (err:any) {
            this.sendEvent(new OutputEvent(`[continue error] ${err.message}\n`));
            this.sendResponse(response);
        }
    }

    protected async nextRequest(response: DebugProtocol.NextResponse): Promise<void> {
        try {
            await this.gdb.sendCommand(`-exec-next`);
            this.sendResponse(response);
        } catch (err:any) {
            this.sendEvent(new OutputEvent(`[next error] ${err.message}\n`));
            this.sendResponse(response);
        }
    }

    protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse,): Promise<void> {
        
        try {
            const raw: any = await this.gdb.sendCommand(`-stack-list-frames`);
            const txt = raw.raw;
            const frames: DebugProtocol.StackFrame[] = [];
            const frameRe = /frame=\{([^}]+)\}/g;

            let id = 0, m;
            while ((m = frameRe.exec(txt)) !== null) {
                const body = m[1];
                const func = (body.match(/func="([^"]+)"/) || [])[1] || '<unknown>';
                const file = (body.match(/file="([^"]+)"/) || [])[1];
                const lineS = (body.match(/line="([^"]+)"/) || [])[1];
                const line = lineS ? parseInt(lineS, 10) : 0;
                const name = func;
                const source = file ? { name: path.basename(file), path: file } : undefined;
                frames.push({
                    id: id ++,
                    name,
                    source,
                    line: Math.max(1, line),
                    column: 1
                } as DebugProtocol.StackFrame);
            }
            response.body = {stackFrames: frames, totalFrames: frames.length};
            this.sendResponse(response);
        } catch(err:any) {
            this.sendEvent(new OutputEvent(`[stackTrace error] ${err.message}\n`));
            response.body = { stackFrames: [], totalFrames: 0 };
            this.sendResponse(response);
        }
    }
}