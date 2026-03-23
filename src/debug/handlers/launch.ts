import { InitializedEvent, OutputEvent, StoppedEvent, TerminatedEvent, ThreadEvent } from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { asString } from '../miParser';
import { GDBController } from '../gdbController';
import { SessionState } from '../sessionState';
import { SourceResolver } from '../sourceResolver';

export function handleInitialize(
    sendResponse: (response: DebugProtocol.InitializeResponse) => void,
    sendEvent: (event: any) => void,
    response: DebugProtocol.InitializeResponse,
): void {
    response.body = { supportsConfigurationDoneRequest: true };
    sendResponse(response);
    sendEvent(new InitializedEvent());
}

export async function handleLaunch(
    defaultGdbPath: string,
    state: SessionState,
    sourceResolverFactory: () => SourceResolver,
    getGdb: () => GDBController,
    setGdb: (gdb: GDBController) => void,
    getSourceResolver: () => SourceResolver,
    setSourceResolver: (resolver: SourceResolver) => void,
    sendEvent: (event: any) => void,
    sendResponse: (response: DebugProtocol.LaunchResponse) => void,
    response: DebugProtocol.LaunchResponse,
    args: any,
): Promise<void> {
    state.launchReady = false;
    state.configurationDoneReceived = false;

    try {
        state.programPath = args.program;
        state.cwd = args.cwd || path.dirname(state.programPath);

        const gdbPath = args.gdbPath || defaultGdbPath;
        setGdb(new GDBController(gdbPath));
        setSourceResolver(sourceResolverFactory());

        if (!state.programPath || !fs.existsSync(state.programPath)) {
            sendEvent(new OutputEvent(`未找到可执行文件: ${state.programPath}\n`));
            sendResponse(response);
            return;
        }

        getSourceResolver().resetForLaunch();
        getSourceResolver().registerSourcePath(state.programPath);

        const normalizedProgram = path.resolve(state.programPath);
        const normalizedCwd = path.resolve(state.cwd);

        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (wsRoot && fs.existsSync(wsRoot)) {
            getSourceResolver().indexWorkspaceSources(wsRoot);
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
            sendEvent(new OutputEvent(`[Launch] 检测到非 ASCII 路径，已切换调试目录: ${safeDir}\n`));
            sendEvent(new OutputEvent(`[Launch] 已复制调试副本: ${safeExe}\n`));
        }

        const gdbProgramCandidates = Array.from(new Set([
            gdbProgramPath,
            gdbProgramPath.replace(/\\/g, '/'),
            gdbProgramPath.replace(/\\/g, '\\\\'),
        ]));

        getGdb().start(gdbWorkingDir);
        getGdb().setCallBack((record) => {
            if (record.type === 'stream') {
                sendEvent(new OutputEvent(record.text));
                return;
            }

            if (record.type === 'async') {
                if (record.clazz === 'stopped') {
                    const tid = parseInt(asString(record.results['thread-id']) || '1', 10);
                    state.currThreadId = Number.isNaN(tid) ? 1 : tid;

                    const reasonRaw = asString(record.results.reason) || '';
                    let reason: 'breakpoint' | 'step' | 'pause' | 'exception' = 'breakpoint';
                    if (reasonRaw === 'end-stepping-range' || reasonRaw === 'function-finished') {
                        reason = 'step';
                    } else if (reasonRaw === 'signal-received') {
                        reason = 'exception';
                    } else if (reasonRaw === 'exited' || reasonRaw === 'exited-normally') {
                        reason = 'pause';
                    }

                    sendEvent(new StoppedEvent(reason, state.currThreadId));
                    return;
                }

                if (record.clazz === 'thread-exited' || record.clazz === 'exited-normally') {
                    sendEvent(new TerminatedEvent());
                    return;
                }

                if (record.asyncClass === 'notify' && record.clazz === 'thread-created') {
                    const tid = parseInt(asString(record.results.id) || `${state.nextThreadId++}`, 10);
                    if (!Number.isNaN(tid)) {
                        state.threads.set(tid, { id: tid, name: `Thread ${tid}` });
                        sendEvent(new ThreadEvent('started', tid));
                    }
                    return;
                }

                if (record.asyncClass === 'notify' && record.clazz === 'thread-exited') {
                    const tid = parseInt(asString(record.results.id) || '', 10);
                    if (!Number.isNaN(tid) && state.threads.has(tid)) {
                        state.threads.delete(tid);
                        sendEvent(new ThreadEvent('exited', tid));
                    }
                }
            }
        });

        let loaded = false;
        const loadErrors: string[] = [];

        for (const candidate of gdbProgramCandidates) {
            try {
                await getGdb().sendCommand(`-file-exec-and-symbols "${candidate}"`);
                loaded = true;
                break;
            } catch (err: any) {
                loadErrors.push(`${candidate} -> ${err?.message || String(err)}`);
            }
        }

        if (!loaded) {
            throw new Error(`无法加载可执行文件:\n${loadErrors.join('\n')}`);
        }

        await getGdb().sendCommand('-gdb-set mi-async on');
        await getGdb().sendCommand(`-environment-cd "${gdbWorkingDir.replace(/\\/g, '/')}"`);
        await getSourceResolver().preInjectSourceMapFromBreakpoints(Array.from(state.breakpoints.keys()));

        state.launchReady = true;

        if (state.configurationDoneReceived) {
            try {
                await getGdb().sendCommand('-exec-run');
                sendEvent(new OutputEvent(`[Launch] GDB-MI 启动成功, 路径: ${state.programPath}\n`));
            } catch (err: any) {
                sendEvent(new OutputEvent(`[run error] ${err.message}\n`));
            }
        }

        sendResponse(response);
    } catch (err) {
        sendEvent(new OutputEvent(`[Launch Error] ${err}\n`));
        sendResponse(response);
    }
}

export async function handleDisconnect(
    gdb: GDBController,
    sendResponse: (response: DebugProtocol.DisconnectResponse) => void,
    sendEvent: (event: any) => void,
    response: DebugProtocol.DisconnectResponse,
): Promise<void> {
    if (gdb.isRunning()) {
        try {
            await gdb.sendCommand('-gdb-exit', 2000);
        } catch {
            // ignore
        }
        gdb.stop();
    }
    sendResponse(response);
    sendEvent(new TerminatedEvent());
}

export function handleThreads(
    state: SessionState,
    sendResponse: (response: DebugProtocol.ThreadsResponse) => void,
    response: DebugProtocol.ThreadsResponse,
): void {
    if (state.threads.size === 0) {
        state.threads.set(1, { id: 1, name: 'Main Thread' });
    }
    response.body = { threads: Array.from(state.threads.values()) };
    sendResponse(response);
}

export async function handleConfigurationDone(
    state: SessionState,
    gdb: GDBController,
    sendEvent: (event: any) => void,
    sendResponse: (response: DebugProtocol.ConfigurationDoneResponse) => void,
    response: DebugProtocol.ConfigurationDoneResponse,
): Promise<void> {
    state.configurationDoneReceived = true;

    if (!state.launchReady) {
        sendEvent(new OutputEvent('[run delayed] 等待 launch 完成后自动执行 -exec-run。\n'));
        sendResponse(response);
        return;
    }

    try {
        await gdb.sendCommand('-exec-run');
        sendEvent(new OutputEvent(`[Launch] GDB-MI 启动成功, 路径: ${state.programPath}\n`));
    } catch (err: any) {
        sendEvent(new OutputEvent(`[run error] ${err.message}\n`));
    }
    sendResponse(response);
}
