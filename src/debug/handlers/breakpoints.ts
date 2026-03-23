import { OutputEvent } from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import * as path from 'path';
import { asString, asTuple } from '../miParser';
import { GDBController } from '../gdbController';
import { SourceResolver } from '../sourceResolver';
import { SessionState } from '../sessionState';

export async function handleSetBreakPoints(
    gdb: GDBController,
    sourceResolver: SourceResolver,
    state: SessionState,
    sendEvent: (event: any) => void,
    sendResponse: (response: DebugProtocol.SetBreakpointsResponse) => void,
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments,
): Promise<void> {
    const source = args.source.path || args.source.name || '<unknown>';
    const sourceResolved = path.resolve(source);
    const normalizedSource = sourceResolved.replace(/\\/g, '/');
    sourceResolver.registerSourcePath(sourceResolved);
    sourceResolver.rememberRecentBreakpointSource(sourceResolved);
    await sourceResolver.applySubstitutePathIfNeeded(source, sourceResolved);

    try {
        const pre = state.breakpoints.get(source) || [];
        const toDelete = pre.map((t) => t.id).filter((id) => id !== undefined) as number[];
        if (toDelete.length > 0) {
            await gdb.sendCommand(`-break-delete ${toDelete.join(' ')}`);
        }

        const outbps: DebugProtocol.Breakpoint[] = [];
        state.breakpoints.set(source, []);

        for (const bp of args.breakpoints || []) {
            try {
                const rec = await gdb.sendCommand(`-break-insert "${normalizedSource}:${bp.line}"`);
                let gdbId: number | undefined;

                const bkpt = asTuple(rec.results.bkpt);
                if (bkpt) {
                    const idRaw = asString(bkpt.number);
                    if (idRaw) {
                        const n = parseInt(idRaw, 10);
                        gdbId = Number.isNaN(n) ? undefined : n;
                    }
                }

                state.breakpoints.get(source)!.push({ line: bp.line, id: gdbId });
                outbps.push({ verified: true, line: bp.line, id: gdbId } as DebugProtocol.Breakpoint);
            } catch {
                outbps.push({ verified: false, line: bp.line } as DebugProtocol.Breakpoint);
            }
        }

        response.body = { breakpoints: outbps };
    } catch (err: any) {
        sendEvent(new OutputEvent(`[setBreakPoints error] ${err.message}\n`));
        response.body = { breakpoints: [] };
    }

    sendResponse(response);
}
