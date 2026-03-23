export type DebugThread = { id: number; name: string };

export type VarRefMeta = {
    type: 'locals' | 'globals';
    frameIndex?: number;
    threadId?: number;
};

export class SessionState {
    public cwd = '';
    public programPath = '';
    public launchReady = false;
    public configurationDoneReceived = false;

    public breakpoints = new Map<string, Array<{ line: number; id?: number }>>();

    public threads = new Map<number, DebugThread>();
    public nextThreadId = 1;
    public currThreadId = 1;

    public nextVarRef = 1;
    public varRefMap = new Map<number, VarRefMeta>();

    public resetForLaunch(): void {
        this.launchReady = false;
        this.configurationDoneReceived = false;
    }
}
