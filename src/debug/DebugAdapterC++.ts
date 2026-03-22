import {
    DebugSession,
    InitializedEvent,
    OutputEvent,
    StoppedEvent,
    TerminatedEvent,
    ThreadEvent,
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';

class GDBController {
    private process?: child_process.ChildProcess;
    private buffer = '';
    private token = 1;
    private pending = new Map<
        number,
        {
            resolve: (r: any) => void;
            reject: (e: any) => void;
            timeout: NodeJS.Timeout;
        }
    >();
    private onCallBack?: (type: string, payload: string) => void;

    public constructor(private readonly gdbPath: string) {}

    private onData(chunk: string) {
        this.buffer += chunk;
        let idx: number;
        while ((idx = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, idx).trim();
            this.buffer = this.buffer.slice(idx + 1);
            if (line.length === 0 || line === '(gdb)') {
                continue;
            }
            this.handleLine(line);
        }
    }

    private handleLine(line: string) {
        const m = line.match(/^(\d+)?(\^|=|\*|~|&|@)(.*)$/s);
        if (!m) {
            this.onCallBack?.('console', line);
            return;
        }

        const token = m[1] ? parseInt(m[1], 10) : null;
        const prefix = m[2];
        const rest = m[3];

        if (prefix === '^') {
            if (token !== null && this.pending.has(token)) {
                const p = this.pending.get(token)!;
                clearTimeout(p.timeout);
                this.pending.delete(token);
                if (rest.startsWith('error')) {
                    const msgMatch = rest.match(/msg="([^"]*)"/);
                    const message = msgMatch ? msgMatch[1] : rest;
                    p.reject(new Error(message));
                } else {
                    p.resolve({ raw: rest });
                }
            } else {
                this.onCallBack?.('response', rest);
            }
            return;
        }

        if (prefix === '*') {
            this.onCallBack?.('async', rest);
            return;
        }

        if (prefix === '=') {
            this.onCallBack?.('notify', rest);
            return;
        }

        if (prefix === '~' || prefix === '&' || prefix === '@') {
            let s = rest;
            if (s.startsWith('"') && s.endsWith('"')) {
                try {
                    s = JSON.parse(s);
                } catch {
                    // ignore parse failure, keep raw text
                }
            }
            s = s.replace(/\\([0-7]{3})/g, (_, oct) => {
                const code = parseInt(oct, 8);
                return String.fromCharCode(code);
            });
            if (typeof Buffer !== 'undefined') {
                s = Buffer.from(s, 'binary').toString('utf8');
            }
            this.onCallBack?.('stream', s);
            return;
        }

        this.onCallBack?.('unknown', line);
    }

    start(cwd?: string) {
        if (this.process) {
            return;
        }

        if (!fs.existsSync(this.gdbPath)) {
            throw new Error(`未找到 gdb: ${this.gdbPath}`);
        }

        this.process = child_process.spawn(this.gdbPath, ['--interpreter=mi2'], {
            cwd,
            shell: false,
        });

        this.process.stdout?.on('data', (d: Buffer) => this.onData(d.toString()));
        this.process.stderr?.on('data', (d: Buffer) => this.onData(`(stderr)${d.toString()}`));

        this.process.on('exit', () => {
            for (const [, val] of this.pending) {
                clearTimeout(val.timeout);
                val.reject(new Error('GDB 已退出'));
            }
            this.pending.clear();
            this.process = undefined;
        });
    }

    stop() {
        if (!this.process) {
            return;
        }

        try {
            this.process.kill();
        } catch {
            // ignore
        }
        this.process = undefined;
    }

    isRunning() {
        return Boolean(this.process);
    }

    setCallBack(cb: (type: string, payload: string) => void) {
        this.onCallBack = cb;
    }

    sendCommand(cmd: string, timeoutMs = 5000): Promise<any> {
        if (!this.process || !this.process.stdin) {
            return Promise.reject(new Error('GDB 停止运行'));
        }

        const token = this.token++;
        const full = `${token}${cmd}\n`;

        return new Promise((resolve, reject) => {
            const to = setTimeout(() => {
                this.pending.delete(token);
                reject(new Error(`GDB 命令超时: ${cmd}`));
            }, timeoutMs);

            this.pending.set(token, {
                resolve,
                reject,
                timeout: to,
            });

            this.process!.stdin!.write(full);
        });
    }
}

export class DebugCPP extends DebugSession {
    private gdb: GDBController;
    private cwd = '';
    private programPath = '';
    private breakpoints = new Map<string, Array<{ line: number; id?: number }>>();

    private threads = new Map<number, { id: number; name: string }>();
    private nextThreadId = 1;
    private currThreadId = 1;

    private frameByThread = new Map<number, DebugProtocol.StackFrame[]>();
    private currFrameByThread = new Map<number, number>();

    private nextVarRef = 1;
    private varRefMap = new Map<
        number,
        {
            type: 'locals' | 'globals';
            frameIndex?: number;
            threadId?: number;
        }
    >();

    public constructor(private readonly defaultGdbPath: string) {
        super();
        this.gdb = new GDBController(defaultGdbPath);
    }

    protected initializeRequest(response: DebugProtocol.InitializeResponse): void {
        response.body = {
            supportsConfigurationDoneRequest: true,
        };
        this.sendResponse(response);
        this.sendEvent(new InitializedEvent());
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: any): Promise<void> {
        try {
            this.programPath = args.program;
            this.cwd = args.cwd || path.dirname(this.programPath);

            const gdbPath = args.gdbPath || this.defaultGdbPath;
            this.gdb = new GDBController(gdbPath);

            if (!this.programPath || !fs.existsSync(this.programPath)) {
                this.sendEvent(new OutputEvent(`未找到可执行文件: ${this.programPath}\n`));
                this.sendResponse(response);
                return;
            }

            const norProPath = this.programPath.replace(/\\/g, '/');
            const norProCwd = this.cwd.replace(/\\/g, '/');

            this.gdb.start(this.cwd);
            this.gdb.setCallBack((type: string, payload: string) => {
                switch (type) {
                    case 'stream':
                        this.sendEvent(new OutputEvent(payload));
                        break;
                    case 'async':
                        if (payload.startsWith('stopped')) {
                            const tidm = payload.match(/thread-id="([^"]+)"/);
                            const tid = tidm ? parseInt(tidm[1], 10) : 1;
                            this.currThreadId = tid;

                            let reason = 'breakpoint';
                            if (payload.includes('reason="end-stepping-range"')) {
                                reason = 'step';
                            } else if (payload.includes('reason="signal-received"')) {
                                reason = 'exception';
                            } else if (payload.includes('reason="exited"') || payload.includes('exited-normally')) {
                                reason = 'pause';
                            }

                            this.sendEvent(new StoppedEvent(reason, tid));
                        } else if (payload.includes('exited-normally') || payload.includes('exited')) {
                            this.sendEvent(new TerminatedEvent());
                        }
                        break;
                    case 'notify':
                        if (payload.startsWith('thread-created')) {
                            const idm = payload.match(/id="([^"]+)"/);
                            const tid = idm ? parseInt(idm[1], 10) : this.nextThreadId++;
                            this.threads.set(tid, { id: tid, name: `Thread ${tid}` });
                            this.sendEvent(new ThreadEvent('started', tid));
                        } else if (payload.startsWith('thread-exited')) {
                            const idm = payload.match(/id="([^"]+)"/);
                            const tid = idm ? parseInt(idm[1], 10) : undefined;
                            if (tid && this.threads.has(tid)) {
                                this.threads.delete(tid);
                                this.sendEvent(new ThreadEvent('exited', tid));
                            }
                        }
                        break;
                    default:
                        break;
                }
            });

            await this.gdb.sendCommand(`-file-exec-and-symbols "${norProPath}"`);
            await this.gdb.sendCommand('-gdb-set mi-async on');
            await this.gdb.sendCommand(`-environment-cd "${norProCwd}"`);

            this.sendResponse(response);
        } catch (err) {
            this.sendEvent(new OutputEvent(`[Launch Error] ${err}\n`));
            this.sendResponse(response);
        }
    }

    protected async disconnectRequest(response: DebugProtocol.DisconnectResponse): Promise<void> {
        if (this.gdb.isRunning()) {
            try {
                await this.gdb.sendCommand('-gdb-exit', 2000);
            } catch {
                // ignore
            }
            this.gdb.stop();
        }
        this.sendResponse(response);
        this.sendEvent(new TerminatedEvent());
    }

    protected async threadsRequest(response: DebugProtocol.ThreadsResponse): Promise<void> {
        try {
            if (this.threads.size === 0) {
                this.threads.set(1, { id: 1, name: 'Main Thread' });
            }
            const list = Array.from(this.threads.values()).map((t) => ({ id: t.id, name: t.name }));
            response.body = { threads: list };
            this.sendResponse(response);
        } catch {
            response.body = { threads: [{ id: 1, name: 'Main Thread' }] };
            this.sendResponse(response);
        }
    }

    protected async pauseRequest(response: DebugProtocol.PauseResponse): Promise<void> {
        try {
            await this.gdb.sendCommand('-exec-interrupt');
            this.sendResponse(response);
        } catch (err: any) {
            this.sendEvent(new OutputEvent(`[pause error] ${err.message}\n`));
            this.sendResponse(response);
        }
    }

    protected async continueRequest(response: DebugProtocol.ContinueResponse): Promise<void> {
        try {
            await this.gdb.sendCommand('-exec-continue');
            response.body = { allThreadsContinued: true };
            this.sendResponse(response);
        } catch (err: any) {
            this.sendEvent(new OutputEvent(`[continue error] ${err.message}\n`));
            this.sendResponse(response);
        }
    }

    protected async nextRequest(response: DebugProtocol.NextResponse): Promise<void> {
        try {
            await this.gdb.sendCommand('-exec-next');
            this.sendResponse(response);
        } catch (err: any) {
            this.sendEvent(new OutputEvent(`[next error] ${err.message}\n`));
            this.sendResponse(response);
        }
    }

    protected async stepInRequest(response: DebugProtocol.StepInResponse): Promise<void> {
        try {
            await this.gdb.sendCommand('-exec-step');
            this.sendResponse(response);
        } catch (err: any) {
            this.sendEvent(new OutputEvent(`[step error] ${err.message}\n`));
            this.sendResponse(response);
        }
    }

    protected async setBreakPointsRequest(
        response: DebugProtocol.SetBreakpointsResponse,
        args: DebugProtocol.SetBreakpointsArguments
    ): Promise<void> {
        const source = args.source.path || args.source.name || '<unknown>';
        const normalizedSource = path.resolve(source).replace(/\\/g, '/');

        try {
            const pre = this.breakpoints.get(source) || [];
            const gdbIdDelete = pre.map((t) => t.id).filter((id) => id !== undefined) as number[];
            if (gdbIdDelete.length > 0) {
                await this.gdb.sendCommand(`-break-delete ${gdbIdDelete.join(' ')}`);
            }

            this.breakpoints.set(source, []);
            const outbps: DebugProtocol.Breakpoint[] = [];

            for (const bp of args.breakpoints || []) {
                try {
                    const line = bp.line;
                    const insertCmd = `-break-insert "${normalizedSource}:${line}"`;
                    const raw: any = await this.gdb.sendCommand(insertCmd);
                    const mat = (raw.raw || '').match(/number="([^"]+)"/);
                    const gdbId = mat ? parseInt(mat[1], 10) : undefined;

                    this.breakpoints.get(source)!.push({ line, id: gdbId });

                    outbps.push({
                        verified: true,
                        line,
                        id: gdbId,
                    } as DebugProtocol.Breakpoint);
                } catch {
                    outbps.push({
                        verified: false,
                        line: bp.line,
                    } as DebugProtocol.Breakpoint);
                }
            }

            response.body = { breakpoints: outbps };
            this.sendResponse(response);
        } catch (err: any) {
            this.sendEvent(new OutputEvent(`[setBreakPoints error] ${err.message}\n`));
            response.body = { breakpoints: [] };
            this.sendResponse(response);
        }
    }

    protected async configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse): Promise<void> {
        try {
            await this.gdb.sendCommand('-exec-run');
            this.sendEvent(new OutputEvent(`[Launch] GDB-MI 启动成功, 路径: ${this.programPath}\n`));
            this.sendResponse(response);
        } catch (err: any) {
            this.sendEvent(new OutputEvent(`[run error] ${err.message}\n`));
            this.sendResponse(response);
        }
    }

    protected async evaluateRequest(
        response: DebugProtocol.EvaluateResponse,
        args: DebugProtocol.EvaluateArguments
    ): Promise<void> {
        try {
            const expr = args.expression;

            if (args.context === 'repl') {
                const raw: any = await this.gdb.sendCommand(
                    expr.startsWith('-') ? expr : `-interpreter-exec console "${expr}"`
                );
                response.body = {
                    result: raw.raw || '(ok)',
                    variablesReference: 0,
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
                variablesReference: 0,
            };
            this.sendResponse(response);
        } catch (err: any) {
            this.sendEvent(new OutputEvent(`[evaluate error] ${err.message}\n`));
            response.body = {
                result: `(error) ${err.message}`,
                variablesReference: 0,
            };
            this.sendResponse(response);
        }
    }

    protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse): Promise<void> {
        try {
            const raw: any = await this.gdb.sendCommand('-stack-list-frames');
            const txt = raw.raw;
            const frames: DebugProtocol.StackFrame[] = [];
            const frameRe = /frame=\{([^}]+)\}/g;

            let id = 0;
            let m: RegExpExecArray | null;
            while ((m = frameRe.exec(txt)) !== null) {
                const body = m[1];
                const func = (body.match(/func="([^"]+)"/) || [])[1] || '<unknown>';
                const file = (body.match(/file="([^"]+)"/) || [])[1];
                const lineS = (body.match(/line="([^"]+)"/) || [])[1];
                const line = lineS ? parseInt(lineS, 10) : 0;
                const source = file
                    ? {
                          name: path.basename(file),
                          path: file,
                      }
                    : undefined;

                frames.push({
                    id: id++,
                    name: func,
                    source,
                    line: Math.max(1, line),
                    column: 1,
                } as DebugProtocol.StackFrame);
            }

            const tid = this.currThreadId || 1;
            this.frameByThread.set(tid, frames);
            if (!this.currFrameByThread.has(tid)) {
                this.currFrameByThread.set(tid, 0);
            }

            response.body = { stackFrames: frames, totalFrames: frames.length };
            this.sendResponse(response);
        } catch (err: any) {
            this.sendEvent(new OutputEvent(`[stackTrace error] ${err.message}\n`));
            response.body = { stackFrames: [], totalFrames: 0 };
            this.sendResponse(response);
        }
    }

    protected async scopesRequest(
        response: DebugProtocol.ScopesResponse,
        args: DebugProtocol.ScopesArguments
    ): Promise<void> {
        try {
            const frameId = args.frameId;
            const localsRef = this.nextVarRef++;
            this.varRefMap.set(localsRef, {
                type: 'locals',
                frameIndex: frameId,
                threadId: this.currThreadId,
            });

            const globalsRef = this.nextVarRef++;
            this.varRefMap.set(globalsRef, {
                type: 'globals',
            });

            response.body = {
                scopes: [
                    { name: 'Locals', variablesReference: localsRef, expensive: false },
                    { name: 'Globals', variablesReference: globalsRef, expensive: true },
                ],
            };
            this.sendResponse(response);
        } catch (err: any) {
            this.sendEvent(new OutputEvent(`[scopes error] ${err.message}\n`));
            response.body = { scopes: [] };
            this.sendResponse(response);
        }
    }

    protected async variablesRequest(
        response: DebugProtocol.VariablesResponse,
        args: DebugProtocol.VariablesArguments
    ): Promise<void> {
        try {
            const vref = args.variablesReference;
            if (!this.varRefMap.has(vref)) {
                response.body = { variables: [] };
                this.sendResponse(response);
                return;
            }

            const meta = this.varRefMap.get(vref)!;
            const vars: DebugProtocol.Variable[] = [];

            if (meta.type === 'globals') {
                const rawAny: any = await this.gdb.sendCommand('-stack-list-variables --all-values');
                const txt = rawAny.raw || '';
                const varRe = /name="([^"]+)",value="([^"]*)"/g;

                let match: RegExpExecArray | null;
                while ((match = varRe.exec(txt)) !== null) {
                    vars.push({
                        name: match[1],
                        value: match[2] || '(unavailable)',
                        variablesReference: 0,
                    });
                }
            } else if (meta.type === 'locals') {
                const frameIndex = meta.frameIndex || 0;
                await this.gdb.sendCommand(`-stack-select-frame ${frameIndex}`);
                const rawAny: any = await this.gdb.sendCommand('-stack-list-variables --all-values');
                const txt = rawAny.raw || '';
                const varRe = /name="([^"]+)",value="([^"]*)"/g;

                let match: RegExpExecArray | null;
                while ((match = varRe.exec(txt)) !== null) {
                    vars.push({
                        name: match[1],
                        value: match[2] || '(unavailable)',
                        variablesReference: 0,
                    });
                }
            }

            response.body = { variables: vars };
            this.sendResponse(response);
        } catch (err: any) {
            this.sendEvent(new OutputEvent(`[variables error] ${err.message}\n`));
            response.body = { variables: [] };
            this.sendResponse(response);
        }
    }
}
