import { OutputEvent } from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { GDBController } from '../gdbController';

export async function handlePause(
    gdb: GDBController,
    sendEvent: (event: any) => void,
    sendResponse: (response: DebugProtocol.PauseResponse) => void,
    response: DebugProtocol.PauseResponse,
): Promise<void> {
    try {
        await gdb.sendCommand('-exec-interrupt');
    } catch (err: any) {
        sendEvent(new OutputEvent(`[pause error] ${err.message}\n`));
    }
    sendResponse(response);
}

export async function handleContinue(
    gdb: GDBController,
    sendEvent: (event: any) => void,
    sendResponse: (response: DebugProtocol.ContinueResponse) => void,
    response: DebugProtocol.ContinueResponse,
): Promise<void> {
    try {
        await gdb.sendCommand('-exec-continue');
        response.body = { allThreadsContinued: true };
    } catch (err: any) {
        sendEvent(new OutputEvent(`[continue error] ${err.message}\n`));
    }
    sendResponse(response);
}

export async function handleNext(
    gdb: GDBController,
    sendEvent: (event: any) => void,
    sendResponse: (response: DebugProtocol.NextResponse) => void,
    response: DebugProtocol.NextResponse,
): Promise<void> {
    try {
        await gdb.sendCommand('-exec-next');
    } catch (err: any) {
        sendEvent(new OutputEvent(`[next error] ${err.message}\n`));
    }
    sendResponse(response);
}

export async function handleStepIn(
    gdb: GDBController,
    sendEvent: (event: any) => void,
    sendResponse: (response: DebugProtocol.StepInResponse) => void,
    response: DebugProtocol.StepInResponse,
): Promise<void> {
    try {
        await gdb.sendCommand('-exec-step');
    } catch (err: any) {
        sendEvent(new OutputEvent(`[step error] ${err.message}\n`));
    }
    sendResponse(response);
}
