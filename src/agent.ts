import { Output, stepCountIs, ToolLoopAgent } from 'ai';
import { createLanguageModel, executionModeOf, resolveModelConfig } from './config.js';
import { runDeterministicTriage } from './fallback.js';
import { type GuardrailInspection, inspectInput, SAFETY_GUARDRAIL_NAME } from './guardrails.js';
import type { LiveOpsStore } from './store.js';
import { createVercelAITools, LiveOpsToolExecutor } from './tools.js';
import { TraceRecorder } from './trace.js';
import {
  type ExecutionMode,
  type TriageOutput,
  TriageOutputSchema,
  type TriageRequest,
  type TriageResponse,
} from './types.js';

export const LAUNCHSHIELD_SYSTEM_INSTRUCTIONS = `You are LaunchShield LiveOps Triage Agent, an autonomous Tier-1 & Tier-2 support specialist for a AAA multiplayer game launch.

Follow these strict operating rules:
1. Always search the Launch Knowledge Base first (\`search_launch_kb\`) to retrieve applicable policy IDs (KB-101 to KB-105).
2. Always verify the player's identity and telemetry (\`get_player_telemetry\`) before making any entitlement or compensation decision.
3. If \`playerId\` is missing, invalid (not matching USR-XXXX), or not found in telemetry, or if \`platform\` is missing/unsupported, do NOT execute any mutating actions. Draft a response via \`draft_player_response\` and return decision \`NEEDS_MORE_INFO\` citing \`KB-105\`.
4. If the player is banned (\`banned: true\`), deny all requests citing \`KB-103\`. Never unban accounts.
5. If the player has \`saveCorruptionFlag: true\` or requests more than the 1,000 Apex Shards autonomous cap (e.g., 5,000 Shards), call \`execute_liveops_action\` with \`actionType: "CREATE_P1_ESCALATION"\` and return decision \`ESCALATED_TO_HUMAN\` citing \`KB-104\` and \`KB-102\`.
6. If the player is eligible for a missing edition entitlement (e.g., DELUXE or ULTIMATE missing "Voidwalker Skin Pack" under \`KB-101\`) and/or outage compensation (\`outageOverlapMinutes >= 60\` for 500 Apex Shards under \`KB-102\`), call \`execute_liveops_action\` with \`actionType: "GRANT_ENTITLEMENT_AND_COMPENSATION"\` and return \`AUTO_RESOLVED\`.
7. If the player owns STANDARD edition and demands DELUXE items, or has \`< 60\` minutes outage overlap, deny the request with \`POLICY_DENIED\` citing \`KB-101\` and/or \`KB-102\`.
8. Always call \`draft_player_response\` before producing the final structured output matching TriageOutputSchema.`;

export interface LlmRunnerContext {
  ticketId: string;
  request: TriageRequest;
  executor: LiveOpsToolExecutor;
}

export type LlmRunner = (ctx: LlmRunnerContext) => Promise<TriageOutput>;

export interface TriageOptions {
  llmRunner?: LlmRunner;
}

export function formatTicketPrompt(ticketId: string, req: TriageRequest): string {
  return [
    `Ticket ID: ${ticketId}`,
    `Player ID: ${req.playerId || '(missing)'}`,
    `Platform: ${req.platform || '(missing)'}`,
    `Subject: ${req.subject}`,
    `Message: ${req.message}`,
  ].join('\n');
}

async function runVercelAIAgent({ ticketId, request, executor }: LlmRunnerContext): Promise<TriageOutput> {
  const model = createLanguageModel(resolveModelConfig());
  if (!model) throw new Error('No LLM provider API key configured for Vercel AI SDK agent.');

  const agent = new ToolLoopAgent({
    model,
    instructions: LAUNCHSHIELD_SYSTEM_INSTRUCTIONS,
    tools: createVercelAITools(executor),
    stopWhen: stepCountIs(6),
    output: Output.object({ schema: TriageOutputSchema }),
  });

  const result = await agent.generate({ prompt: formatTicketPrompt(ticketId, request) });
  return TriageOutputSchema.parse(result.output);
}

function securityRefusal(
  req: TriageRequest,
  inspection: GuardrailInspection,
  executor: LiveOpsToolExecutor,
): TriageOutput {
  const violations = inspection.violations.join(', ');
  const citations = ['KB-102', 'KB-103'];
  const draft = executor.draftPlayerResponse({
    playerId: req.playerId || 'UNKNOWN',
    gamertag: 'FlaggedRequester',
    decision: 'SECURITY_REFUSAL',
    policyCitations: citations,
    actionsSummary: `Blocked adversarial payload (${violations}). Zero account mutations executed.`,
    receiptOrTicketId: null,
  });

  return {
    decision: 'SECURITY_REFUSAL',
    summary: `Input Guardrail Tripwire triggered: blocked prompt injection / policy bypass attempt (${violations}).`,
    playerReply: draft.formattedReply,
    policyCitations: citations,
    actionsTaken: [
      `Triggered ${SAFETY_GUARDRAIL_NAME} tripwire before mutating tools could run`,
      `Blocked violations: ${violations}`,
    ],
    escalationTicketId: null,
  };
}

async function decide(
  ticketId: string,
  req: TriageRequest,
  executor: LiveOpsToolExecutor,
  trace: TraceRecorder,
  llmRunner: LlmRunner | null,
): Promise<{ mode: ExecutionMode; output: TriageOutput }> {
  if (!llmRunner) {
    return { mode: 'deterministic-fallback', output: runDeterministicTriage(req, executor) };
  }

  try {
    return { mode: 'vercel-ai-sdk', output: await llmRunner({ ticketId, request: req, executor }) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[triage ${ticketId}] LLM agent failed, using deterministic fallback: ${error}`);
    trace.record('strategy_fallback:vercel-ai-sdk', { ticketId }, () => ({
      fallbackTo: 'deterministic-fallback',
      error,
    }));
    return { mode: 'deterministic-fallback', output: runDeterministicTriage(req, executor) };
  }
}

export async function triageTicket(
  req: TriageRequest,
  store: LiveOpsStore,
  options: TriageOptions = {},
): Promise<TriageResponse> {
  const startTime = Date.now();
  const ticketId = req.ticketId || `TKT-${Math.floor(1000 + Math.random() * 9000)}`;
  const trace = new TraceRecorder();
  const executor = new LiveOpsToolExecutor(store, trace);
  const config = resolveModelConfig();
  const llmRunner = options.llmRunner ?? (config.provider ? runVercelAIAgent : null);

  console.info(
    `[triage ${ticketId}] accepted player=${req.playerId || '(missing)'} platform=${req.platform || '(missing)'} subject="${req.subject}" model=${config.provider ? `${config.provider}/${config.modelId}` : 'none'}`,
  );

  const inspection = inspectInput(formatTicketPrompt(ticketId, req), trace);
  if (inspection.tripwireTriggered) {
    console.warn(`[triage ${ticketId}] guardrail tripped: ${inspection.violations.join(', ')}`);
  }

  const { mode, output } = inspection.tripwireTriggered
    ? { mode: executionModeOf(config), output: securityRefusal(req, inspection, executor) }
    : await decide(ticketId, req, executor, trace, llmRunner);

  const traces = trace.getTraces();
  const totalDurationMs = Math.max(1, Date.now() - startTime);
  console.info(
    `[triage ${ticketId}] ${output.decision} mode=${mode} tools=[${traces.map((t) => t.toolName).join(' > ')}] ${totalDurationMs}ms`,
  );

  return {
    ticketId,
    executionMode: mode,
    output,
    traces,
    totalDurationMs,
    store: store.getSnapshot(),
  };
}
