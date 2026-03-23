import { OutputEvent } from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { asArray, asString, asTuple } from '../miParser';
import { GDBController } from '../gdbController';
import { SessionState } from '../sessionState';

export function handleScopes(
    state: SessionState,
    sendResponse: (response: DebugProtocol.ScopesResponse) => void,
    response: DebugProtocol.ScopesResponse,
    args: DebugProtocol.ScopesArguments,
): void {
    const localsRef = state.nextVarRef++;
    state.varRefMap.set(localsRef, {
        type: 'locals',
        frameIndex: args.frameId,
        threadId: state.currThreadId,
    });

    const globalsRef = state.nextVarRef++;
    state.varRefMap.set(globalsRef, { type: 'globals' });

    response.body = {
        scopes: [
            { name: 'Locals', variablesReference: localsRef, expensive: false },
            { name: 'Globals', variablesReference: globalsRef, expensive: true },
        ],
    };
    sendResponse(response);
}

export async function handleVariables(
    gdb: GDBController,
    state: SessionState,
    sendEvent: (event: any) => void,
    sendResponse: (response: DebugProtocol.VariablesResponse) => void,
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments,
): Promise<void> {
    const vars: DebugProtocol.Variable[] = [];

    try {
        const meta = state.varRefMap.get(args.variablesReference);
        if (!meta) {
            response.body = { variables: [] };
            sendResponse(response);
            return;
        }

        if (meta.type === 'locals') {
            await gdb.sendCommand(`-stack-select-frame ${meta.frameIndex || 0}`);
        }

        const rec = await gdb.sendCommand('-stack-list-variables --all-values');
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
        sendEvent(new OutputEvent(`[variables error] ${err.message}\n`));
    }

    response.body = { variables: vars };
    sendResponse(response);
}
