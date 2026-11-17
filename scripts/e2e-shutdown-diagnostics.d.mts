export function lifecycleRecords(devLog: string, limit?: number): string[];
export function sampleMainThread(output: string, limit?: number): string[];
export function procThreadLine(tid: string, stat: string, wchan: string): string;
export function describeStuckShutdown(options: { pid: number; devLogPath?: string; platform?: NodeJS.Platform }): Promise<string>;
