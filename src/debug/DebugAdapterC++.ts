import { DebugSession, OutputEvent } from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { asString } from './miParser';
import { GDBController } from './gdbController';
import { SourceResolver } from './sourceResolver';
import { SessionState } from './sessionState';
import { handleContinue, handleNext, handlePause, handleStepIn } from './handlers/control';
import { handleSetBreakPoints } from './handlers/breakpoints';
import { handleStackTrace } from './handlers/stackTrace';
import { handleScopes, handleVariables } from './handlers/variables';
import {
    handleConfigurationDone,
    handleDisconnect,
    handleInitialize,
    handleLaunch,
    handleThreads,
} from './handlers/launch';


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
        handleInitialize(this.sendResponse.bind(this), this.sendEvent.bind(this), response);
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: any): Promise<void> {
        await handleLaunch(
            this.defaultGdbPath,
            this.state,
            () => this.createSourceResolver(),
            () => this.gdb,
            (gdb) => {
                this.gdb = gdb;
            },
            () => this.sourceResolver,
            (resolver) => {
                this.sourceResolver = resolver;
            },
            this.sendEvent.bind(this),
            this.sendResponse.bind(this),
            response,
            args,
        );
    }

    protected async disconnectRequest(response: DebugProtocol.DisconnectResponse): Promise<void> {
        await handleDisconnect(this.gdb, this.sendResponse.bind(this), this.sendEvent.bind(this), response);
    }

    protected async threadsRequest(response: DebugProtocol.ThreadsResponse): Promise<void> {
        handleThreads(this.state, this.sendResponse.bind(this), response);
    }

    protected async pauseRequest(response: DebugProtocol.PauseResponse): Promise<void> {
        await handlePause(this.gdb, this.sendEvent.bind(this), this.sendResponse.bind(this), response);
    }

    protected async continueRequest(response: DebugProtocol.ContinueResponse): Promise<void> {
        await handleContinue(this.gdb, this.sendEvent.bind(this), this.sendResponse.bind(this), response);
    }

    protected async nextRequest(response: DebugProtocol.NextResponse): Promise<void> {
        await handleNext(this.gdb, this.sendEvent.bind(this), this.sendResponse.bind(this), response);
    }

    protected async stepInRequest(response: DebugProtocol.StepInResponse): Promise<void> {
        await handleStepIn(this.gdb, this.sendEvent.bind(this), this.sendResponse.bind(this), response);
    }

    protected async setBreakPointsRequest(
        response: DebugProtocol.SetBreakpointsResponse,
        args: DebugProtocol.SetBreakpointsArguments
    ): Promise<void> {
        await handleSetBreakPoints(
            this.gdb,
            this.sourceResolver,
            this.state,
            this.sendEvent.bind(this),
            this.sendResponse.bind(this),
            response,
            args,
        );
    }

    protected async configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse): Promise<void> {
        await handleConfigurationDone(
            this.state,
            this.gdb,
            this.sendEvent.bind(this),
            this.sendResponse.bind(this),
            response,
        );
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
        await handleStackTrace(
            this.gdb,
            this.sourceResolver,
            this.sendEvent.bind(this),
            this.sendResponse.bind(this),
            response,
        );
    }

    protected async scopesRequest(
        response: DebugProtocol.ScopesResponse,
        args: DebugProtocol.ScopesArguments
    ): Promise<void> {
        handleScopes(this.state, this.sendResponse.bind(this), response, args);
    }

    protected async variablesRequest(
        response: DebugProtocol.VariablesResponse,
        args: DebugProtocol.VariablesArguments
    ): Promise<void> {
        await handleVariables(
            this.gdb,
            this.state,
            this.sendEvent.bind(this),
            this.sendResponse.bind(this),
            response,
            args,
        );
    }
}
