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

type MIValue = string | MITuple | MIValue[];
type MITuple = Record<string, MIValue>;

interface MIRecord {
    clazz: string;
    results: MITuple;
    raw: string;
}

function parseCString(input: string, start: number): { value: string; next: number } {
    let i = start;
    let out = '';
    if (input[i] !== '"') {
        throw new Error('invalid c-string start');
    }
    i++;

    while (i < input.length) {
        const ch = input[i];
        if (ch === '"') {
            return { value: out, next: i + 1 };
        }
        if (ch === '\\') {
            i++;
            if (i >= input.length) {
                break;
            }
            const esc = input[i];
            switch (esc) {
                case 'n':
                    out += '\n';
                    break;
                case 'r':
                    out += '\r';
                    break;
                case 't':
                    out += '\t';
                    break;
                case '"':
                    out += '"';
                    break;
                case '\\':
                    out += '\\';
                    break;
                default:
                    out += esc;
                    break;
            }
            i++;
            continue;
        }
        out += ch;
        i++;
    }

    throw new Error('unterminated c-string');
}

function skipComma(input: string, i: number): number {
    return input[i] === ',' ? i + 1 : i;
}

function parseIdentifier(input: string, start: number): { ident: string; next: number } {
    let i = start;
    let out = '';
    while (i < input.length) {
        const ch = input[i];
        if (/[_a-zA-Z0-9\-]/.test(ch)) {
            out += ch;
            i++;
        } else {
            break;
        }
    }
    return { ident: out, next: i };
}

function parseConst(input: string, start: number): { value: string; next: number } {
    let i = start;
    let out = '';
    while (i < input.length) {
        const ch = input[i];
        if (ch === ',' || ch === '}' || ch === ']') {
            break;
        }
        out += ch;
        i++;
    }
    return { value: out.trim(), next: i };
}

function parseValue(input: string, start: number): { value: MIValue; next: number } {
    const ch = input[start];

    if (ch === '"') {
        return parseCString(input, start);
    }
    if (ch === '{') {
        return parseTuple(input, start);
    }
    if (ch === '[') {
        return parseList(input, start);
    }
    return parseConst(input, start);
}

function parseTuple(input: string, start: number): { value: MITuple; next: number } {
    let i = start;
    const obj: MITuple = {};
    if (input[i] !== '{') {
        throw new Error('invalid tuple start');
    }
    i++;

    while (i < input.length) {
        if (input[i] === '}') {
            return { value: obj, next: i + 1 };
        }

        const key = parseIdentifier(input, i);
        i = key.next;
        if (!key.ident || input[i] !== '=') {
            const cv = parseConst(input, i);
            obj[`$${Object.keys(obj).length}`] = cv.value;
            i = cv.next;
        } else {
            i++; // '='
            const parsed = parseValue(input, i);
            obj[key.ident] = parsed.value;
            i = parsed.next;
        }
        i = skipComma(input, i);
    }

    throw new Error('unterminated tuple');
}

function parseList(input: string, start: number): { value: MIValue[]; next: number } {
    let i = start;
    const arr: MIValue[] = [];
    if (input[i] !== '[') {
        throw new Error('invalid list start');
    }
    i++;

    while (i < input.length) {
        if (input[i] === ']') {
            return { value: arr, next: i + 1 };
        }

        const id = parseIdentifier(input, i);
        if (id.ident && input[id.next] === '=') {
            i = id.next + 1;
            const parsed = parseValue(input, i);
            arr.push({ [id.ident]: parsed.value } as MITuple);
            i = parsed.next;
        } else {
            const parsed = parseValue(input, i);
            arr.push(parsed.value);
            i = parsed.next;
        }

        i = skipComma(input, i);
    }

    throw new Error('unterminated list');
}

function parseMIRecord(rest: string): MIRecord {
    const firstComma = rest.indexOf(',');
    if (firstComma === -1) {
        return { clazz: rest, results: {}, raw: rest };
    }

    const clazz = rest.slice(0, firstComma);
    const tail = rest.slice(firstComma + 1);

    const fakeTuple = `{${tail}}`;
    const parsed = parseTuple(fakeTuple, 0);

    return {
        clazz,
        results: parsed.value,
        raw: rest,
    };
}

function asTuple(v: MIValue | undefined): MITuple | undefined {
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as MITuple) : undefined;
}

function asArray(v: MIValue | undefined): MIValue[] | undefined {
    return Array.isArray(v) ? v : undefined;
}

function asString(v: MIValue | undefined): string | undefined {
    return typeof v === 'string' ? v : undefined;
}

class GDBController {
    private process?: child_process.ChildProcess;
    private buffer = '';
    private token = 1;
    private pending = new Map<number, {
        resolve: (r: MIRecord) => void;
        reject: (e: Error) => void;
        timeout: NodeJS.Timeout;
    }>();
    private onCallBack?: (type: string, payload: string | MIRecord) => void;

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
        const m = line.match(/^(\d+)?(\^|=|\*|~|&|@)(.*)$/s);
        if (!m) {
            this.onCallBack?.('console', line);
            return;
        }

        const token = m[1] ? parseInt(m[1], 10) : null;
        const prefix = m[2];
        const rest = m[3];

        if (prefix === '^') {
            const record = parseMIRecord(rest);
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
                this.onCallBack?.('response', record);
            }
            return;
        }

        if (prefix === '*' || prefix === '=') {
            const record = parseMIRecord(rest);
            this.onCallBack?.(prefix === '*' ? 'async' : 'notify', record);
            return;
        }

        if (prefix === '~' || prefix === '&' || prefix === '@') {
            let s = rest;
            if (s.startsWith('"')) {
                try {
                    s = parseCString(s, 0).value;
                } catch {
                    // keep raw
                }
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

        this.process = child_process.spawn(this.gdbPath, ['--interpreter=mi2'], { cwd, shell: false });
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

    setCallBack(cb: (type: string, payload: string | MIRecord) => void) {
        this.onCallBack = cb;
    }

    sendCommand(cmd: string, timeoutMs = 5000): Promise<MIRecord> {
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

            const norProPath = this.programPath.replace(/\\/g, '/');
            const norProCwd = this.cwd.replace(/\\/g, '/');

            this.gdb.start(this.cwd);
            this.gdb.setCallBack((type, payload) => {
                if (type === 'stream' && typeof payload === 'string') {
                    this.sendEvent(new OutputEvent(payload));
                    return;
                }

                if ((type === 'async' || type === 'notify') && typeof payload !== 'string') {
                    if (type === 'async' && payload.clazz === 'stopped') {
                        const tid = parseInt(asString(payload.results['thread-id']) || '1', 10);
                        this.currThreadId = Number.isNaN(tid) ? 1 : tid;

                        const reasonRaw = asString(payload.results.reason) || '';
                        let reason: 'breakpoint' | 'step' | 'pause' | 'exception' = 'breakpoint';
                        if (reasonRaw === 'end-stepping-range' || reasonRaw === 'function-finished') {
                            reason = 'step';
                        } else if (reasonRaw === 'signal-received') {
                            reason = 'exception';
                        } else if (reasonRaw === 'signal-received' || reasonRaw === 'exited') {
                            reason = 'pause';
                        }

                        this.sendEvent(new StoppedEvent(reason, this.currThreadId));
                        return;
                    }

                    if (type === 'async' && (payload.clazz === 'thread-exited' || payload.clazz === 'exited-normally')) {
                        this.sendEvent(new TerminatedEvent());
                        return;
                    }

                    if (type === 'notify' && payload.clazz === 'thread-created') {
                        const tid = parseInt(asString(payload.results.id) || `${this.nextThreadId++}`, 10);
                        if (!Number.isNaN(tid)) {
                            this.threads.set(tid, { id: tid, name: `Thread ${tid}` });
                            this.sendEvent(new ThreadEvent('started', tid));
                        }
                        return;
                    }

                    if (type === 'notify' && payload.clazz === 'thread-exited') {
                        const tid = parseInt(asString(payload.results.id) || '', 10);
                        if (!Number.isNaN(tid) && this.threads.has(tid)) {
                            this.threads.delete(tid);
                            this.sendEvent(new ThreadEvent('exited', tid));
                        }
                    }
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
        try {
            await this.gdb.sendCommand('-exec-run');
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
