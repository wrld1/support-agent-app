import type { ToolTraceStep } from './types.js';

export class TraceRecorder {
  private readonly steps: ToolTraceStep[] = [];

  record<T>(toolName: string, args: object, fn: () => T): T {
    const start = Date.now();
    const result = fn();
    this.steps.push({
      step: this.steps.length + 1,
      toolName,
      args,
      result,
      durationMs: Math.max(1, Date.now() - start),
      timestamp: new Date().toISOString(),
    });
    return result;
  }

  getTraces(): ToolTraceStep[] {
    return this.steps.map((s) => ({ ...s }));
  }
}
