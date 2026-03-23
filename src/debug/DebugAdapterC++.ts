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
import { asArray, asString, asTuple, MIRecord, MIResultRecord, parseMIOutputLine } from './miParser';

class GDBController {
    private process?: child_process.ChildProcess;
    private buffer = '';
    private token = 1;
    private pending = new Map<number, {
        resolve: (r: MIResultRecord) => void;
        reject: (e: Error) => void;
        timeout: NodeJS.Timeout;
    }>();
    private onCallBack?: (record: MIRecord) => void;

    public constructor(private readonly gdbPath: string) {}

    private onData(chunk: string) {
        this.buffer += chunk;
        let idx: number;
        while ((idx = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, idx).trim();
            this.buffer = this.buffer.slice(idx + 1);
            if (!line || line === '(gdb)') {
                continue;
            }
            this.handleLine(line);
        }
    }

    private handleLine(line: string) {
        const record = parseMIOutputLine(line);

        if (record.type === 'result') {
            const token = record.token;
            if (token !== null && this.pending.has(token)) {
                const p = this.pending.get(token)!;
                clearTimeout(p.timeout);
                this.pending.delete(token);

                if (record.clazz === 'error') {
                    const message = asString(record.results.msg) || record.raw;
                    p.reject(new Error(message));
                } else {
                    p.resolve(record);
                }
            } else {
                this.onCallBack?.(record);
            }
            return;
        }

        this.onCallBack?.(record);
    }

    start(cwd?: string) {
        if (this.process) {
            return;
        }
        if (!fs.existsSync(this.gdbPath)) {
            throw new Error(`未找到 gdb: ${this.gdbPath}`);
        }

        this.process = child_process.spawn(this.gdbPath, ['--interpreter=mi2'], { cwd, shell: false });
        this.process.stdout?.on('data', (d: Buffer) => this.onData(d.toString()));
        this.process.stderr?.on('data', (d: Buffer) => this.onData(`&"${d.toString().replace(/"/g, '\\"')}"`));
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

    setCallBack(cb: (record: MIRecord) => void) {
        this.onCallBack = cb;
    }

    sendCommand(cmd: string, timeoutMs = 5000): Promise<MIResultRecord> {
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

            this.pending.set(token, { resolve, reject, timeout: to });
            this.process!.stdin!.write(full);
        });
    }
}

export class DebugCPP extends DebugSession {
    private gdb: GDBController;
    private cwd = '';
    private programPath = '';
    private launched = false;
    private readyToRun = false;
    private breakpoints = new Map<string, Array<{ line: number; id?: number }>>();

    private threads = new Map<number, { id: number; name: string }>();
    private nextThreadId = 1;
    private currThreadId = 1;

    private nextVarRef = 1;
    private varRefMap = new Map<number, {
        type: 'locals' | 'globals';
        frameIndex?: number;
        threadId?: number;
    }>();

    private toMIString(value: string): string {
        return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }

    public constructor(private readonly defaultGdbPath: string) {
        super();
        this.gdb = new GDBController(defaultGdbPath);
    }

    protected initializeRequest(response: DebugProtocol.InitializeResponse): void {
        response.body = { supportsConfigurationDoneRequest: true };
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

            const resolvedProgramPath = path.resolve(this.programPath);
            const resolvedCwd = path.resolve(this.cwd);

            this.gdb.start(resolvedCwd);
            this.gdb.setCallBack((record) => {
                if (record.type === 'stream') {
                    this.sendEvent(new OutputEvent(record.text));
                    return;
                }

                if (record.type === 'async') {
                    if (record.clazz === 'stopped') {
                        const tid = parseInt(asString(record.results['thread-id']) || '1', 10);
                        this.currThreadId = Number.isNaN(tid) ? 1 : tid;

                        const reasonRaw = asString(record.results.reason) || '';
                        let reason: 'breakpoint' | 'step' | 'pause' | 'exception' = 'breakpoint';
                        if (reasonRaw === 'end-stepping-range' || reasonRaw === 'function-finished') {
                            reason = 'step';
                        } else if (reasonRaw === 'signal-received') {
                            reason = 'exception';
                        } else if (reasonRaw === 'exited' || reasonRaw === 'exited-normally') {
                            reason = 'pause';
                        }

                        this.sendEvent(new StoppedEvent(reason, this.currThreadId));
                        return;
                    }

                    if (record.clazz === 'thread-exited' || record.clazz === 'exited-normally') {
                        this.sendEvent(new TerminatedEvent());
                        return;
                    }

                    if (record.asyncClass === 'notify' && record.clazz === 'thread-created') {
                        const tid = parseInt(asString(record.results.id) || `${this.nextThreadId++}`, 10);
                        if (!Number.isNaN(tid)) {
                            this.threads.set(tid, { id: tid, name: `Thread ${tid}` });
                            this.sendEvent(new ThreadEvent('started', tid));
                        }
                        return;
                    }

                    if (record.asyncClass === 'notify' && record.clazz === 'thread-exited') {
                        const tid = parseInt(asString(record.results.id) || '', 10);
                        if (!Number.isNaN(tid) && this.threads.has(tid)) {
                            this.threads.delete(tid);
                            this.sendEvent(new ThreadEvent('exited', tid));
                        }
                    }
                }
            });

            await this.gdb.sendCommand(`-file-exec-and-symbols ${this.toMIString(resolvedProgramPath)}`);
            await this.gdb.sendCommand('-gdb-set mi-async on');
            await this.gdb.sendCommand(`-environment-cd ${this.toMIString(resolvedCwd)}`);
            this.launched = false;
            this.readyToRun = true;

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
        this.readyToRun = false;
        this.launched = false;
        this.sendResponse(response);
        this.sendEvent(new TerminatedEvent());
    }

    protected async threadsRequest(response: DebugProtocol.ThreadsResponse): Promise<void> {
        if (this.threads.size === 0) {
            this.threads.set(1, { id: 1, name: 'Main Thread' });
        }
        response.body = { threads: Array.from(this.threads.values()) };
        this.sendResponse(response);
    }

    protected async pauseRequest(response: DebugProtocol.PauseResponse): Promise<void> {
        try {
            await this.gdb.sendCommand('-exec-interrupt');
        } catch (err: any) {
            this.sendEvent(new OutputEvent(`[pause error] ${err.message}\n`));
        }
        this.sendResponse(response);
    }

    protected async continueRequest(response: DebugProtocol.ContinueResponse): Promise<void> {
        try {
            await this.gdb.sendCommand('-exec-continue');
            response.body = { allThreadsContinued: true };
        } catch (err: any) {
            this.sendEvent(new OutputEvent(`[continue error] ${err.message}\n`));
        }
        this.sendResponse(response);
    }

    protected async nextRequest(response: DebugProtocol.NextResponse): Promise<void> {
        try {
            await this.gdb.sendCommand('-exec-next');
        } catch (err: any) {
            this.sendEvent(new OutputEvent(`[next error] ${err.message}\n`));
        }
        this.sendResponse(response);
    }

    protected async stepInRequest(response: DebugProtocol.StepInResponse): Promise<void> {
        try {
            await this.gdb.sendCommand('-exec-step');
        } catch (err: any) {
            this.sendEvent(new OutputEvent(`[step error] ${err.message}\n`));
        }
        this.sendResponse(response);
    }

    protected async setBreakPointsRequest(
        response: DebugProtocol.SetBreakpointsResponse,
        args: DebugProtocol.SetBreakpointsArguments
    ): Promise<void> {
        const source = args.source.path || args.source.name || '<unknown>';
        const normalizedSource = path.resolve(source).replace(/\\/g, '/');

        try {
            const pre = this.breakpoints.get(source) || [];
            const toDelete = pre.map((t) => t.id).filter((id) => id !== undefined) as number[];
            if (toDelete.length > 0) {
                await this.gdb.sendCommand(`-break-delete ${toDelete.join(' ')}`);
            }

            const outbps: DebugProtocol.Breakpoint[] = [];
            this.breakpoints.set(source, []);

            for (const bp of args.breakpoints || []) {
                try {
                    const rec = await this.gdb.sendCommand(`-break-insert "${normalizedSource}:${bp.line}"`);
                    let gdbId: number | undefined;

                    const bkpt = asTuple(rec.results.bkpt);
                    if (bkpt) {
                        const idRaw = asString(bkpt.number);
                        if (idRaw) {
                            const n = parseInt(idRaw, 10);
                            gdbId = Number.isNaN(n) ? undefined : n;
                        }
                    }

                    this.breakpoints.get(source)!.push({ line: bp.line, id: gdbId });
                    outbps.push({ verified: true, line: bp.line, id: gdbId } as DebugProtocol.Breakpoint);
                } catch {
                    outbps.push({ verified: false, line: bp.line } as DebugProtocol.Breakpoint);
                }
            }

            response.body = { breakpoints: outbps };
        } catch (err: any) {
            this.sendEvent(new OutputEvent(`[setBreakPoints error] ${err.message}\n`));
            response.body = { breakpoints: [] };
        }

        this.sendResponse(response);
    }

    protected async configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse): Promise<void> {
        if (!this.readyToRun || this.launched) {
            this.sendResponse(response);
            return;
        }

        try {
            await this.gdb.sendCommand('-exec-run');
            this.launched = true;
            this.sendEvent(new OutputEvent(`[Launch] GDB-MI 启动成功, 路径: ${this.programPath}\n`));
        } catch (err: any) {
            this.sendEvent(new OutputEvent(`[run error] ${err.message}\n`));
        }
        this.sendResponse(response);
    }

    protected async evaluateRequest(
        response: DebugProtocol.EvaluateResponse,
        args: DebugProtocol.EvaluateArguments
    ): Promise<void> {
        try {
            const expr = args.expression;
            if (args.context === 'repl') {
                const rec = await this.gdb.sendCommand(expr.startsWith('-') ? expr : `-interpreter-exec console "${expr}"`);
                response.body = { result: rec.raw || '(ok)', variablesReference: 0 };
                this.sendResponse(response);
                return;
            }

            const rec = await this.gdb.sendCommand(`-data-evaluate-expression "${expr}"`);
            response.body = {
                result: asString(rec.results.value) || '(no value)',
                variablesReference: 0,
            };
        } catch (err: any) {
            this.sendEvent(new OutputEvent(`[evaluate error] ${err.message}\n`));
            response.body = { result: `(error) ${err.message}`, variablesReference: 0 };
        }
        this.sendResponse(response);
    }

    protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse): Promise<void> {
        try {
            const rec = await this.gdb.sendCommand('-stack-list-frames');
            const stack = asArray(rec.results.stack);
            const frames: DebugProtocol.StackFrame[] = [];

            if (stack) {
                let id = 0;
                for (const it of stack) {
                    const frameObj = asTuple(asTuple(it)?.frame ?? it);
                    if (!frameObj) {
                        continue;
                    }

                    const file = asString(frameObj.file) || asString(frameObj.fullname);
                    const line = parseInt(asString(frameObj.line) || '1', 10);
                    frames.push({
                        id: id++,
                        name: asString(frameObj.func) || '<unknown>',
                        source: file ? { name: path.basename(file), path: file } : undefined,
                        line: Number.isNaN(line) ? 1 : Math.max(1, line),
                        column: 1,
                    } as DebugProtocol.StackFrame);
                }
            }

            response.body = { stackFrames: frames, totalFrames: frames.length };
        } catch (err: any) {
            this.sendEvent(new OutputEvent(`[stackTrace error] ${err.message}\n`));
            response.body = { stackFrames: [], totalFrames: 0 };
        }
        this.sendResponse(response);
    }

    protected async scopesRequest(
        response: DebugProtocol.ScopesResponse,
        args: DebugProtocol.ScopesArguments
    ): Promise<void> {
        const localsRef = this.nextVarRef++;
        this.varRefMap.set(localsRef, {
            type: 'locals',
            frameIndex: args.frameId,
            threadId: this.currThreadId,
        });

        const globalsRef = this.nextVarRef++;
        this.varRefMap.set(globalsRef, { type: 'globals' });

        response.body = {
            scopes: [
                { name: 'Locals', variablesReference: localsRef, expensive: false },
                { name: 'Globals', variablesReference: globalsRef, expensive: true },
            ],
        };
        this.sendResponse(response);
    }

    protected async variablesRequest(
        response: DebugProtocol.VariablesResponse,
        args: DebugProtocol.VariablesArguments
    ): Promise<void> {
        const vars: DebugProtocol.Variable[] = [];

        try {
            const meta = this.varRefMap.get(args.variablesReference);
            if (!meta) {
                response.body = { variables: [] };
                this.sendResponse(response);
                return;
            }

            if (meta.type === 'locals') {
                await this.gdb.sendCommand(`-stack-select-frame ${meta.frameIndex || 0}`);
            }

            const rec = await this.gdb.sendCommand('-stack-list-variables --all-values');
            const list = asArray(rec.results.variables) || [];

            for (const item of list) {
                const tuple = asTuple(asTuple(item)?.varobj ?? item);
                const name = asString(tuple?.name);
                if (!name) {
                    continue;
                }
                vars.push({
                    name,
                    value: asString(tuple?.value) || '(unavailable)',
                    variablesReference: 0,
                });
            }
        } catch (err: any) {
            this.sendEvent(new OutputEvent(`[variables error] ${err.message}\n`));
        }

        response.body = { variables: vars };
        this.sendResponse(response);
    }
}
