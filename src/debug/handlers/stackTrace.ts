import { OutputEvent } from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import * as path from 'path';
import { asArray, asString, asTuple } from '../miParser';
import { GDBController } from '../gdbController';
import { SourceResolver } from '../sourceResolver';

export async function handleStackTrace(
    gdb: GDBController,
    sourceResolver: SourceResolver,
    sendEvent: (event: any) => void,
    sendResponse: (response: DebugProtocol.StackTraceResponse) => void,
    response: DebugProtocol.StackTraceResponse,
): Promise<void> {
    try {
        const rec = await gdb.sendCommand('-stack-list-frames');
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
                const displayFile = sourceResolver.resolveSourcePathFromGdb(fileRaw);
                await sourceResolver.applySubstitutePathIfNeeded(fileRaw, displayFile);
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
        sendEvent(new OutputEvent(`[stackTrace error] ${err.message}\n`));
        response.body = { stackFrames: [], totalFrames: 0 };
    }
    sendResponse(response);
}
