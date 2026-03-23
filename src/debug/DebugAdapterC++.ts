import {
    DebugSession,
    InitializedEvent,
    OutputEvent,
    StoppedEvent,
    TerminatedEvent,
    ThreadEvent,
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
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
    private launchReady = false;
    private configurationDoneReceived = false;

    private sourcePathByBasename = new Map<string, string>();
    private workspaceSourceIndexByBasename = new Map<string, string[]>();
    private recentBreakpointSources: string[] = [];
    private gdbSubstitutePathApplied = new Set<string>();
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

    private normalizePath(p: string): string {
        return p.replace(/\\/g, '/').toLowerCase();
    }

    private indexWorkspaceSources(rootDir: string): void {
        this.workspaceSourceIndexByBasename.clear();

        const stack: string[] = [rootDir];
        while (stack.length > 0) {
            const current = stack.pop()!;
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(current, { withFileTypes: true });
            } catch {
                continue;
            }

            for (const entry of entries) {
                const full = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.vscode') {
                        continue;
                    }
                    stack.push(full);
                    continue;
                }

                if (!entry.isFile()) {
                    continue;
                }

                if (!/\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(entry.name)) {
                    continue;
                }

                const key = entry.name.toLowerCase();
                const arr = this.workspaceSourceIndexByBasename.get(key) || [];
                arr.push(path.resolve(full));
                this.workspaceSourceIndexByBasename.set(key, arr);
            }
        }
    }

    private registerSourcePath(sourcePath: string): void {
        const resolved = path.resolve(sourcePath);
        this.sourcePathByBasename.set(path.basename(resolved), resolved);
    }

    private rememberRecentBreakpointSource(sourcePath: string): void {
        const resolved = path.resolve(sourcePath);
        const normalized = this.normalizePath(resolved);
        this.recentBreakpointSources = [
            resolved,
            ...this.recentBreakpointSources.filter((p) => this.normalizePath(p) !== normalized),
        ].slice(0, 20);
    }

    private pickBestSourceCandidate(candidates: string[], fileRaw: string): string {
        if (candidates.length === 1) {
            return candidates[0];
        }

        const normalizedRaw = this.normalizePath(fileRaw);
        const bySuffix = candidates.find((p) => normalizedRaw.endsWith(path.basename(p).toLowerCase()));
        if (bySuffix) {
            return bySuffix;
        }

        for (const recent of this.recentBreakpointSources) {
            const recentDir = this.normalizePath(path.dirname(recent));
            const preferred = candidates.find((p) => this.normalizePath(path.dirname(p)).includes(recentDir));
            if (preferred) {
                return preferred;
            }
        }

        return candidates[0];
    }

    private async applySubstitutePathIfNeeded(fileRaw?: string, mappedFile?: string): Promise<void> {
        if (!fileRaw || !mappedFile) {
            return;
        }

        const rawDir = path.dirname(fileRaw).replace(/\\/g, '/');
        const mappedDir = path.dirname(mappedFile).replace(/\\/g, '/');

        if (!rawDir || !mappedDir || this.normalizePath(rawDir) === this.normalizePath(mappedDir)) {
            return;
        }

        const key = `${this.normalizePath(rawDir)}=>${this.normalizePath(mappedDir)}`;
        if (this.gdbSubstitutePathApplied.has(key)) {
            return;
        }

        try {
            await this.gdb.sendCommand(`-interpreter-exec console "set substitute-path ${rawDir} ${mappedDir}"`);
            this.gdbSubstitutePathApplied.add(key);
            this.sendEvent(new OutputEvent(`[SourceMap] substitute-path: ${rawDir} -> ${mappedDir}\n`));
        } catch (err: any) {
            this.sendEvent(new OutputEvent(`[SourceMap warn] set substitute-path 失败: ${err?.message || String(err)}\n`));
        }
    }

    private async preInjectSourceMapFromBreakpoints(): Promise<void> {
        const sources = Array.from(this.breakpoints.keys());
        const sourceDirs = Array.from(new Set(sources.map((s) => path.dirname(path.resolve(s)).replace(/\\/g, '/'))));

        for (const dir of sourceDirs) {
            const variants = Array.from(new Set([dir, dir.replace(/\//g, '\\')]));
            for (const rawDir of variants) {
                const mappedDir = dir;
                const key = `${this.normalizePath(rawDir)}=>${this.normalizePath(mappedDir)}`;
                if (this.gdbSubstitutePathApplied.has(key)) {
                    continue;
                }

                try {
                    await this.gdb.sendCommand(`-interpreter-exec console "set substitute-path ${rawDir} ${mappedDir}"`);
                    this.gdbSubstitutePathApplied.add(key);
                } catch (err: any) {
                    this.sendEvent(new OutputEvent(`[SourceMap warn] preinject 失败: ${err?.message || String(err)}\n`));
                }
            }
        }
    }

    private resolveSourcePathFromGdb(fileRaw?: string): string | undefined {
        if (!fileRaw) {
            return undefined;
        }

        const baseName = path.basename(fileRaw);
        const direct = this.sourcePathByBasename.get(baseName);
        if (direct) {
            return direct;
        }

        const candidates = this.workspaceSourceIndexByBasename.get(baseName.toLowerCase()) || [];
        if (candidates.length === 0) {
            return fileRaw;
        }

        const normalizedRaw = this.normalizePath(fileRaw);
        const exact = candidates.find((p) => normalizedRaw.endsWith(this.normalizePath(p)));
        if (exact) {
            this.sourcePathByBasename.set(baseName, exact);
            return exact;
        }

        const best = this.pickBestSourceCandidate(candidates, fileRaw);
        this.sourcePathByBasename.set(baseName, best);
        return best;
    }

    protected initializeRequest(response: DebugProtocol.InitializeResponse): void {
        response.body = { supportsConfigurationDoneRequest: true };
        this.sendResponse(response);
        this.sendEvent(new InitializedEvent());
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: any): Promise<void> {
        this.launchReady = false;
        this.configurationDoneReceived = false;
        this.gdbSubstitutePathApplied.clear();

        try {
            this.programPath = args.program;
            this.cwd = args.cwd || path.dirname(this.programPath);
            this.stopAtEntry = Boolean(args.stopAtEntry);

            const gdbPath = args.gdbPath || this.defaultGdbPath;
            this.gdb = new GDBController(gdbPath);

            if (!this.programPath || !fs.existsSync(this.programPath)) {
                this.sendEvent(new OutputEvent(`未找到可执行文件: ${this.programPath}\n`));
                this.sendResponse(response);
                return;
            }

            this.sourcePathByBasename.clear();
            this.registerSourcePath(this.programPath);

            const normalizedProgram = path.resolve(this.programPath);
            const normalizedCwd = path.resolve(this.cwd);

            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (wsRoot && fs.existsSync(wsRoot)) {
                this.indexWorkspaceSources(wsRoot);
            }

            let gdbProgramPath = normalizedProgram;
            let gdbWorkingDir = normalizedCwd;
            const hasNonAsciiPath = /[^\x00-\x7F]/.test(normalizedProgram) || /[^\x00-\x7F]/.test(normalizedCwd);
            if (hasNonAsciiPath) {
                const safeDir = path.join(os.tmpdir(), 'xq-cppdbg');
                fs.mkdirSync(safeDir, { recursive: true });
                const safeExe = path.join(safeDir, path.basename(normalizedProgram));
                fs.copyFileSync(normalizedProgram, safeExe);
                gdbProgramPath = safeExe;
                gdbWorkingDir = safeDir;
                this.sendEvent(new OutputEvent(`[Launch] 检测到非 ASCII 路径，已切换调试目录: ${safeDir}\n`));
                this.sendEvent(new OutputEvent(`[Launch] 已复制调试副本: ${safeExe}\n`));
            }

            const gdbProgramCandidates = Array.from(new Set([
                gdbProgramPath,
                gdbProgramPath.replace(/\\/g, '/'),
                gdbProgramPath.replace(/\\/g, '\\\\'),
            ]));

            this.gdb.start(gdbWorkingDir);
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

            let loaded = false;
            const loadErrors: string[] = [];

            for (const candidate of gdbProgramCandidates) {
                try {
                    await this.gdb.sendCommand(`-file-exec-and-symbols "${candidate}"`);
                    loaded = true;
                    break;
                } catch (err: any) {
                    loadErrors.push(`${candidate} -> ${err?.message || String(err)}`);
                }
            }

            if (!loaded) {
                throw new Error(`无法加载可执行文件:\n${loadErrors.join('\n')}`);
            }

            await this.gdb.sendCommand('-gdb-set mi-async on');
            await this.gdb.sendCommand(`-environment-cd "${gdbWorkingDir.replace(/\\/g, '/')}"`);
            await this.preInjectSourceMapFromBreakpoints();

            this.launchReady = true;

            if (this.configurationDoneReceived) {
                try {
                    await this.gdb.sendCommand('-exec-run');
                    this.sendEvent(new OutputEvent(`[Launch] GDB-MI 启动成功, 路径: ${this.programPath}\n`));
                } catch (err: any) {
                    this.sendEvent(new OutputEvent(`[run error] ${err.message}\n`));
                }
            }

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
        const sourceResolved = path.resolve(source);
        const normalizedSource = sourceResolved.replace(/\\/g, '/');
        this.registerSourcePath(sourceResolved);
        this.rememberRecentBreakpointSource(sourceResolved);
        await this.applySubstitutePathIfNeeded(source, sourceResolved);

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
        this.configurationDoneReceived = true;

        if (!this.launchReady) {
            this.sendEvent(new OutputEvent('[run delayed] 等待 launch 完成后自动执行 -exec-run。\n'));
            this.sendResponse(response);
            return;
        }

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

                    const fileRaw = asString(frameObj.fullname) || asString(frameObj.file);
                    const displayFile = this.resolveSourcePathFromGdb(fileRaw);
                    await this.applySubstitutePathIfNeeded(fileRaw, displayFile);
                    const line = parseInt(asString(frameObj.line) || '1', 10);
                    frames.push({
                        id: id++,
                        name: asString(frameObj.func) || '<unknown>',
                        source: displayFile
                            ? { name: path.basename(displayFile), path: displayFile }
                            : undefined,
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


