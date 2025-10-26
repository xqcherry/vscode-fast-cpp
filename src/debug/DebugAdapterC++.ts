import { DebugSession, InitializedEvent, ThreadEvent, OutputEvent, StoppedEvent, TerminatedEvent} from '@vscode/debugadapter';
import { DebugProtocol} from '@vscode/debugprotocol';
import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
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
                this.pending.delete(token);
                if(rest.startsWith('done')) {
                    p.resolve({
                        raw: rest
                    });
                }
                else if(rest.startsWith('error')) {
                    const msgMatch = rest.match(/msg="([^"]*)"/);
                    const message = msgMatch ? msgMatch[1] : rest;
                    p.reject(new Error(message));
                }
                else {
                    p.resolve({
                        raw: rest
                    });
                }
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
            // 转义后utg-8编码输出
            s = s.replace(/\\([0-7]{3})/g, (_, oct) => {
                const code = parseInt(oct, 8);
                return String.fromCharCode(code);
            });
            if (typeof Buffer !== 'undefined') {
                s = Buffer.from(s, 'binary').toString('utf8');
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
            for (const [, val] of this.pending) {
                clearTimeout(val.timeout);
                val.reject(new Error(`GDB已退出`));
            }
            this.pending.clear();
            this.process?.stdout?.removeAllListeners();
            this.process?.stderr?.removeAllListeners();
            this.process = undefined;
        });
        this.process.on('error', err => {
            this.onCallBack?.('console', `[gdb spawn error] ${err.message}`);
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
    private stopAtEntry = false;
    private breakpoints = new Map<string, Array<{ line: number, id?: number }>>();

    // 进程管理
    private threads = new Map<number, {id: number, name: string}>();
    private nextThreadId = 1;
    private currThreadId = 1;
    // 栈帧管理
    private frameByThread = new Map<number, DebugProtocol.StackFrame[]>();
    private currFrameByThread = new Map<number, number>();
    // 变量引用管理
    private nextVarRef = 1;
    private varRefMap = new Map<number, {
        type: 'locals' | 'globals',
        frameIndex?: number,
        threadId?: number
    }>();

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
        // this.sendEvent(new OutputEvent(`[DEBUG] program: ${args.program}\n`));
        // this.sendEvent(new OutputEvent(`[DEBUG] cwd: ${args.cwd}\n`));

        try {
            this.programPath = args.program;
            this.cwd = args.cwd || path.dirname(this.programPath);
            this.stopAtEntry = Boolean(args.stopAtEntry);

            if (!this.programPath || !fs.existsSync(this.programPath)) {
                this.sendEvent(new OutputEvent(`未找到可执行文件: ${this.programPath}\n`));
                this.sendResponse(response);
                return;
            }
            // 一定要将路径中/改成\, 不然识别不到xd
            const norProPath = this.programPath.replace(/\\/g, '/');
            const norProCwd = this.cwd.replace(/\\/g, '/');

            this.gdb.start(this.cwd); // 启动gdb
            this.gdb.setCallBack((type: string, payload: string) => { // 监听gdb解析并发送给vscode
                switch(type) {
                    case 'stream':
                        this.sendEvent(new OutputEvent(payload + '\n'));
                        break;
                    case 'async':
                        if(payload.startsWith('stopped')) {
                            const tidm = payload.match(/thread-id="([^"]+)"/);
                            const tid = tidm ? parseInt(tidm[1], 10) : 1;
                            this.currThreadId = tid;

                            const reasonMatch = payload.match(/reason="([^"]+)"/);
                            const reasonRaw = reasonMatch ? reasonMatch[1] : '';
                            let reason: string;

                            switch(reasonRaw) {
                                case 'breakpoint-hit':
                                    reason = 'breakpoint';
                                    break;
                                case 'end-stepping-range':
                                case 'function-finished':
                                case 'step':
                                    reason = 'step';
                                    break;
                                case 'signal-received':
                                case 'exception-received':
                                    reason = 'exception';
                                    break;
                                case 'watchpoint-trigger':
                                    reason = 'data breakpoint';
                                    break;
                                case 'exited-normally':
                                case 'exited':
                                    reason = 'pause';
                                    break;
                                default:
                                    reason = 'pause';
                                    break;
                            }
                            this.sendEvent(new StoppedEvent(reason, tid));
                        }
                        break;
                    case 'notify':
                        if(payload.startsWith('thread-created')) {
                            const idm = payload.match(/id="([^"]+)"/);
                            const tid = idm ? parseInt(idm[1], 10) : this.nextThreadId ++;
                            const nameMatch = payload.match(/name="([^"]+)"/);
                            const name = nameMatch ? nameMatch[1] : `Thread ${tid}`;
                            this.threads.set(tid, {id: tid, name});
                            this.sendEvent(new ThreadEvent('started', tid));
                        }
                        else if(payload.startsWith('thread-exited')) {
                            const idm = payload.match(/id="([^"]+)"/);
                            const tid = idm ? parseInt(idm[1], 10) : undefined;
                            if(tid && this.threads.has(tid)) {
                                this.threads.delete(tid);
                                this.sendEvent(new ThreadEvent('exited', tid));
                            }
                        }
                        break;
                }
            });
            await this.gdb.sendCommand(`-gdb-set target-async on`, 12000); // ensure async mode is enabled before running the target
            // 初始会话,自动编译当前文件
            await this.gdb.sendCommand(`-file-exec-and-symbols "${norProPath}"`, 12000); // 指定要调试的可执行文件路径
            await this.gdb.sendCommand(`-environment-cd "${norProCwd}"`, 12000); // 设置工作目录
    
            this.sendResponse(response);
        } catch(err) {
            this.sendEvent(new OutputEvent(`[Launch Error] ${err}\n`));
            this.sendResponse(response);
        }
    }
    // 退出gdb
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
    // 线程管理
    protected async threadsRequest(response: DebugProtocol.ThreadsResponse): Promise<void> {
        try {
            if(this.threads.size === 0) {
                this.threads.set(1, {id: 1, name: 'Main Thread'});
            }
            const list = Array.from(this.threads.values()).map(t => ({id: t.id, name: t.name}));
            response.body = {threads: list};
            this.sendResponse(response);
        } catch(err : any) {
            response.body = {threads: [{id: 1, name: 'Main Thread'}]};
            this.sendResponse(response);
        }
    }
    // 暂停程序
    protected async pauseRequest(response: DebugProtocol.PauseResponse): Promise<void> {
        try {
            await this.gdb.sendCommand('-exec-interrupt');
            this.sendResponse(response);
        } catch (err : any) {
            this.sendEvent(new OutputEvent(`[pause error] ${err.message}\n`));
            this.sendResponse(response);
        }
    }
    // 继续执行
    protected async continueRequest(response: DebugProtocol.ContinueResponse): Promise<void> {
        try {
            await this.gdb.sendCommand(`-exec-continue`);
            this.sendResponse(response);
        } catch (err:any) {
            this.sendEvent(new OutputEvent(`[continue error] ${err.message}\n`));
            this.sendResponse(response);
        }
    }
    // 单步跳过
    protected async nextRequest(response: DebugProtocol.NextResponse): Promise<void> {
        try {
            await this.gdb.sendCommand(`-exec-next`);
            this.sendResponse(response);
        } catch (err:any) {
            this.sendEvent(new OutputEvent(`[next error] ${err.message}\n`));
            this.sendResponse(response);
        }
    }
    // 单步进入
    protected async stepInRequest(response: DebugProtocol.StepInResponse): Promise<void> {
        try {
            await this.gdb.sendCommand(`-exec-step`);
            this.sendResponse(response);
        } catch (err:any) {
            this.sendEvent(new OutputEvent(`[step error] ${err.message}\n`));
            this.sendResponse(response);
        }
    }
    // 断点设置
    protected async setBreakPointsRequest(
        response: DebugProtocol.SetBreakpointsResponse,
        args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
        
        const source = args.source.path || args.source.name || '<unknown>';
        const norProsource = path.resolve(source).replace(/\\/g, '/');
        // 每次setBreakpoints都是完整替换source的断点列表,
        // 先删除之前该source的所有断点，否则命令行与可视化不同步xd
        const pre = this.breakpoints.get(source) || [];
        const gdbIdDelete = pre.map(t => t.id).filter(id => id !== undefined) as number[];
        if(gdbIdDelete.length > 0) {
            await this.gdb.sendCommand(`-break-delete ${gdbIdDelete.join(' ')}`);
        }

        this.breakpoints.set(source, []);
        const outbps : DebugProtocol.Breakpoint[] = [];
        for(const bp of args.breakpoints || []) {
            try {
                const line = bp.line;
                const insertcmd = `-break-insert "${norProsource}:${line}"`;
                const raw: any = await this.gdb.sendCommand(insertcmd);
                const body = raw.raw || '';
                if(!body.startsWith('done')) {
                    throw new Error(body);
                }
                const mat = body.match(/number="([^"]+)"/);
                const gdbId = mat ? parseInt(mat[1], 10) : undefined;
                
                this.breakpoints.get(source)!.push({
                    line: line,
                    id: gdbId
                });
                outbps.push({
                    verified: true,
                    line: line
                } as DebugProtocol.Breakpoint);
            } catch(err) {
                const message = String(err);
                this.sendEvent(new OutputEvent(`[breakpoint error] ${message}\n`));
                outbps.push({
                    verified: false,
                    line: bp.line
                } as DebugProtocol.Breakpoint);
            }
        }
        response.body = {breakpoints: outbps};
        this.sendResponse(response);
    }
    // 启动调试
    protected async configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse): Promise<void> {
        try {
            const runCmd = this.stopAtEntry ? `-exec-run --start` : `-exec-run`;
            await this.gdb.sendCommand(runCmd);
            this.sendEvent(new OutputEvent(`[Launch] GBD-MI 启动成功, 路径：${this.programPath}\n`));
            this.sendResponse(response);
        } catch (err:any) {
            this.sendEvent(new OutputEvent(`[run error] ${err.message}\n`));
            this.sendResponse(response);
        }
    }
    // 表达式求值
    protected async evaluateRequest(
        response: DebugProtocol.EvaluateResponse,
        args: DebugProtocol.EvaluateArguments
    ): Promise<void> {
        try {
            const expr = args.expression;

            if (args.context === 'repl') {
                const raw: any = await this.gdb.sendCommand(expr.startsWith('-') ? expr : `-interpreter-exec console "${expr}"`);
                response.body = {
                    result: raw.raw || '(ok)',
                    variablesReference: 0
                };
                this.sendResponse(response);
                return;
            }
            
            const raw: any = await this.gdb.sendCommand(`-data-evaluate-expression "${expr}"`);
            const txt = raw.raw;
            const match = txt.match(/value="([^"]+)"/);
            const val = match ? match[1] : '(no value)';

            response.body = {
                result: val,
                variablesReference: 0
            };
            this.sendResponse(response);
        } catch (err: any) {
            this.sendEvent(new OutputEvent(`[evaluate error] ${err.message}\n`));
            response.body = {
                result: `(error) ${err.message}`,
                variablesReference: 0 
            };
            this.sendResponse(response);
        }
    }
    // 查看堆栈
    protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse): Promise<void> {
        
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
            // 存储栈帧
            const tid = this.currThreadId || 1;
            this.frameByThread.set(tid, frames);
            if(!this.currFrameByThread.has(tid)) {
                this.currFrameByThread.set(tid, 0);
            }
            response.body = {stackFrames: frames, totalFrames: frames.length};
            this.sendResponse(response);
        } catch(err:any) {
            this.sendEvent(new OutputEvent(`[stackTrace error] ${err.message}\n`));
            response.body = { stackFrames: [], totalFrames: 0 };
            this.sendResponse(response);
        }
    }
    // 处理作用域
    protected async scopesRequest(
        response: DebugProtocol.ScopesResponse,
        args: DebugProtocol.ScopesArguments): Promise<void> {
        try {
            const frameId = args.frameId;
            const localsRef = this.nextVarRef ++;
            this.varRefMap.set(localsRef, {
                type: 'locals',
                frameIndex: frameId,
                threadId: this.currThreadId
            });
            const globalsRef = this.nextVarRef ++;
            this.varRefMap.set(globalsRef, {
                type: 'globals'
            });

            response.body = {
                scopes: [
                    { name: 'Locals', variablesReference: localsRef, expensive: false },
                    { name: 'Globals', variablesReference: globalsRef, expensive: true }
                ]
            };
            this.sendResponse(response);
        } catch (err: any) {
            this.sendEvent(new OutputEvent(`[scopes error] ${err.message}\n`));
            response.body = {scopes: [] };
            this.sendResponse(response);
        }
    }
    // 查看变量
    protected async variablesRequest(
        response: DebugProtocol.VariablesResponse,
        args: DebugProtocol.VariablesArguments): Promise<void> {
        try {
            const vref = args.variablesReference;
            if(!this.varRefMap.has(vref)) {
                response.body = { variables: [] };
                this.sendResponse(response);
                return;
            }
            const meta = this.varRefMap.get(vref)!;
            const vars : DebugProtocol.Variable[] = [];

            // if(meta.type === 'globals') {
            //     let handle: string | undefined;
            //     try {
            //         const createRaw: any = await this.gdb.sendCommand(`-var-create - --frame 0 *@`);
            //         const createBody = createRaw.raw || '';
            //         const handleMatch = createBody.match(/name="([^"]+)"/);
            //         handle = handleMatch ? handleMatch[1] : undefined;
            //         if(!handle) {
            //             throw new Error('failed to create global scope handle');
            //         }

            //         const listRaw: any = await this.gdb.sendCommand(`-var-list-children --all-values ${handle}`);
            //         const listBody = listRaw.raw || '';
            //         const childRe = /child=\{name="([^"]+)",exp="([^"]+)",value="([^"]*)"/g;

            //         let child;
            //         while((child = childRe.exec(listBody)) !== null) {
            //             const name = child[2] || child[1];
            //             const value = child[3] || '(unavailable)';
            //             vars.push({
            //                 name: name,
            //                 value: value,
            //                 variablesReference: 0
            //             });
            //         }
            //     } finally {
            //         if(handle) {
            //             await this.gdb.sendCommand(`-var-delete ${handle}`);
            //         }
            //     }
            // }
            if (meta.type === 'locals') {
                const frameIndex = meta.frameIndex || 0;
                await this.gdb.sendCommand(`-stack-select-frame ${frameIndex}`);
                const rawAny: any = await this.gdb.sendCommand(`-stack-list-variables --all-values`);
                const txt = rawAny.raw || '';
                const varRe = /name="([^"]+)",value="([^"]*)"/g;

                let match;
                while ((match = varRe.exec(txt)) !== null) {
                    vars.push({
                        name: match[1],
                        value: match[2] || '(unavailable)',
                        variablesReference: 0
                    });
                }
            }
            response.body = { variables: vars };
            this.sendResponse(response);
        } catch(err : any) {
            this.sendEvent(new OutputEvent(`[variables error] ${err.message}\n`));
            response.body = {variables: []};
            this.sendResponse(response);
        }
    }
}


