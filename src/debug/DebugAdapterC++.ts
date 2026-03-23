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
import { asArray, asString, asTuple } from './miParser';
import { GDBController } from './gdbController';
import { SourceResolver } from './sourceResolver';
import { SessionState } from './sessionState';


export class DebugCPP extends DebugSession {
    private gdb: GDBController;
    private state = new SessionState();

    private sourceResolver: SourceResolver;

    public constructor(private readonly defaultGdbPath: string) {
        super();
        this.gdb = new GDBController(defaultGdbPath);
        this.sourceResolver = this.createSourceResolver();
    }

    private createSourceResolver(): SourceResolver {
        return new SourceResolver(
            (cmd) => this.gdb.sendCommand(cmd),
            (message) => this.sendEvent(new OutputEvent(message)),
        );
    }

    protected initializeRequest(response: DebugProtocol.InitializeResponse): void {
        response.body = { supportsConfigurationDoneRequest: true };
        this.sendResponse(response);
        this.sendEvent(new InitializedEvent());
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: any): Promise<void> {
        this.state.launchReady = false;
        this.state.configurationDoneReceived = false;

        try {
            this.state.programPath = args.program;
            this.state.cwd = args.cwd || path.dirname(this.state.programPath);

            const gdbPath = args.gdbPath || this.defaultGdbPath;
            this.gdb = new GDBController(gdbPath);
            this.sourceResolver = this.createSourceResolver();

            if (!this.state.programPath || !fs.existsSync(this.state.programPath)) {
                this.sendEvent(new OutputEvent(`未找到可执行文件: ${this.state.programPath}\n`));
                this.sendResponse(response);
                return;
            }

            this.sourceResolver.resetForLaunch();
            this.sourceResolver.registerSourcePath(this.state.programPath);

            const normalizedProgram = path.resolve(this.state.programPath);
            const normalizedCwd = path.resolve(this.state.cwd);

            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (wsRoot && fs.existsSync(wsRoot)) {
                this.sourceResolver.indexWorkspaceSources(wsRoot);
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
                        this.state.currThreadId = Number.isNaN(tid) ? 1 : tid;

                        const reasonRaw = asString(record.results.reason) || '';
                        let reason: 'breakpoint' | 'step' | 'pause' | 'exception' = 'breakpoint';
                        if (reasonRaw === 'end-stepping-range' || reasonRaw === 'function-finished') {
                            reason = 'step';
                        } else if (reasonRaw === 'signal-received') {
                            reason = 'exception';
                        } else if (reasonRaw === 'exited' || reasonRaw === 'exited-normally') {
                            reason = 'pause';
                        }

                        this.sendEvent(new StoppedEvent(reason, this.state.currThreadId));
                        return;
                    }

                    if (record.clazz === 'thread-exited' || record.clazz === 'exited-normally') {
                        this.sendEvent(new TerminatedEvent());
                        return;
                    }

                    if (record.asyncClass === 'notify' && record.clazz === 'thread-created') {
                        const tid = parseInt(asString(record.results.id) || `${this.state.nextThreadId++}`, 10);
                        if (!Number.isNaN(tid)) {
                            this.state.threads.set(tid, { id: tid, name: `Thread ${tid}` });
                            this.sendEvent(new ThreadEvent('started', tid));
                        }
                        return;
                    }

                    if (record.asyncClass === 'notify' && record.clazz === 'thread-exited') {
                        const tid = parseInt(asString(record.results.id) || '', 10);
                        if (!Number.isNaN(tid) && this.state.threads.has(tid)) {
                            this.state.threads.delete(tid);
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
            await this.sourceResolver.preInjectSourceMapFromBreakpoints(Array.from(this.state.breakpoints.keys()));

            this.state.launchReady = true;

            if (this.state.configurationDoneReceived) {
                try {
                    await this.gdb.sendCommand('-exec-run');
                    this.sendEvent(new OutputEvent(`[Launch] GDB-MI 启动成功, 路径: ${this.state.programPath}\n`));
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
        if (this.state.threads.size === 0) {
            this.state.threads.set(1, { id: 1, name: 'Main Thread' });
        }
        response.body = { threads: Array.from(this.state.threads.values()) };
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
        this.sourceResolver.registerSourcePath(sourceResolved);
        this.sourceResolver.rememberRecentBreakpointSource(sourceResolved);
        await this.sourceResolver.applySubstitutePathIfNeeded(source, sourceResolved);

        try {
            const pre = this.state.breakpoints.get(source) || [];
            const toDelete = pre.map((t) => t.id).filter((id) => id !== undefined) as number[];
            if (toDelete.length > 0) {
                await this.gdb.sendCommand(`-break-delete ${toDelete.join(' ')}`);
            }

            const outbps: DebugProtocol.Breakpoint[] = [];
            this.state.breakpoints.set(source, []);

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

                    this.state.breakpoints.get(source)!.push({ line: bp.line, id: gdbId });
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
        this.state.configurationDoneReceived = true;

        if (!this.state.launchReady) {
            this.sendEvent(new OutputEvent('[run delayed] 等待 launch 完成后自动执行 -exec-run。\n'));
            this.sendResponse(response);
            return;
        }

        try {
            await this.gdb.sendCommand('-exec-run');
            this.sendEvent(new OutputEvent(`[Launch] GDB-MI 启动成功, 路径: ${this.state.programPath}\n`));
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
                    const displayFile = this.sourceResolver.resolveSourcePathFromGdb(fileRaw);
                    await this.sourceResolver.applySubstitutePathIfNeeded(fileRaw, displayFile);
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
        const localsRef = this.state.nextVarRef++;
        this.state.varRefMap.set(localsRef, {
            type: 'locals',
            frameIndex: args.frameId,
            threadId: this.state.currThreadId,
        });

        const globalsRef = this.state.nextVarRef++;
        this.state.varRefMap.set(globalsRef, { type: 'globals' });

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
            const meta = this.state.varRefMap.get(args.variablesReference);
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
