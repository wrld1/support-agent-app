import { tool } from 'ai';
import { isSupportedPlatform, isValidPlayerId } from './policy.js';
import type { LiveOpsStore } from './store.js';
import type { TraceRecorder } from './trace.js';
import {
  type DecisionCategory,
  type DraftPlayerResponseParams,
  DraftPlayerResponseParamsSchema,
  type EscalationTicket,
  type ExecuteLiveOpsActionParams,
  ExecuteLiveOpsActionParamsSchema,
  type GetPlayerTelemetryParams,
  GetPlayerTelemetryParamsSchema,
  type GrantLedgerEntry,
  type PlayerRecord,
  type SearchLaunchKBParams,
  SearchLaunchKBParamsSchema,
} from './types.js';

export interface TelemetryLookupResult {
  found: boolean;
  verified: boolean;
  telemetry?: PlayerRecord;
  error?: string;
}

export type LiveOpsActionResult =
  | { status: 'ESCALATION_CREATED'; escalationTicket: EscalationTicket }
  | { status: 'ACTION_BLOCKED_BY_GUARDRAIL'; error: string }
  | {
      status: 'GRANT_APPLIED';
      grantReceipt: GrantLedgerEntry;
      updatedBalance: number;
      updatedGrantedItems: string[];
    };

export interface CommittedAction {
  args: ExecuteLiveOpsActionParams;
  result: Exclude<LiveOpsActionResult, { status: 'ACTION_BLOCKED_BY_GUARDRAIL' }>;
}

type ReplyTemplate = (args: DraftPlayerResponseParams, citations: string) => string;

const REPLY_TEMPLATES: Record<DecisionCategory, ReplyTemplate> = {
  AUTO_RESOLVED: (a, c) =>
    `Hello ${a.gamertag} (${a.playerId}),\n\nWe verified your telemetry and resolved your ticket automatically under Launch Policy ${c}. ${a.actionsSummary}${a.receiptOrTicketId ? ` (Receipt ID: ${a.receiptOrTicketId})` : ''}.\n\nPlease restart your game client to sync your updated locker and Apex Shards balance. Thank you for playing LaunchShield!`,
  POLICY_DENIED: (a, c) =>
    `Hello ${a.gamertag} (${a.playerId}),\n\nThank you for contacting LaunchShield LiveOps Support. After reviewing your account telemetry against Launch Policy ${c}, we cannot fulfill this request: ${a.actionsSummary}.\n\nIf you believe your edition purchase receipt shows otherwise, please reply with your platform store invoice ID.`,
  ESCALATED_TO_HUMAN: (a, c) =>
    `Hello ${a.gamertag} (${a.playerId}),\n\nWe detected a critical condition on your profile requiring LiveOps Engineering and Lead intervention under ${c}. ${a.actionsSummary}.\n\nYour case has been escalated with high priority${a.receiptOrTicketId ? ` under ticket ${a.receiptOrTicketId}` : ''}. A LiveOps specialist will update you shortly—please avoid overwriting your local cloud save slot in the meantime.`,
  NEEDS_MORE_INFO: (a, c) =>
    `Hello,\n\nWe want to help resolve your issue quickly, but we could not verify your account telemetry under policy ${c} (${a.actionsSummary}).\n\nPlease reply with:\n1. Your valid Support Player ID (format USR-XXXX, found in Settings > Account > Support ID)\n2. Your gaming platform (Steam, PS5, or Xbox)`,
  SECURITY_REFUSAL: (_a, c) =>
    `Request refused by LaunchShield Security Guardrail (${c}). Automated system overrides, ban reversals, unverified currency minting, and confidential roadmap disclosures are strictly prohibited.`,
};

export class LiveOpsToolExecutor {
  private committed: CommittedAction | null = null;

  constructor(
    private readonly store: LiveOpsStore,
    private readonly trace: TraceRecorder,
  ) {}

  get committedAction(): CommittedAction | null {
    return this.committed;
  }

  searchLaunchKB(args: SearchLaunchKBParams) {
    return this.trace.record('search_launch_kb', args, () => {
      const articles = this.store.searchKB(args.query, args.category);
      return {
        matchCount: articles.length,
        articles: articles.map(({ id, title, category, summary, rules }) => ({ id, title, category, summary, rules })),
      };
    });
  }

  getPlayerTelemetry(args: GetPlayerTelemetryParams): TelemetryLookupResult {
    return this.trace.record('get_player_telemetry', args, () => this.lookupPlayer(args));
  }

  executeLiveOpsAction(args: ExecuteLiveOpsActionParams): LiveOpsActionResult {
    return this.trace.record('execute_liveops_action', args, () => {
      const result = this.runAction(args);
      if (result.status !== 'ACTION_BLOCKED_BY_GUARDRAIL') this.committed = { args, result };
      return result;
    });
  }

  draftPlayerResponse(args: DraftPlayerResponseParams) {
    return this.trace.record('draft_player_response', args, () => ({
      formattedReply: REPLY_TEMPLATES[args.decision](args, args.policyCitations.join(', ') || 'KB-105'),
      policyCitations: args.policyCitations,
      receiptOrTicketId: args.receiptOrTicketId,
    }));
  }

  private lookupPlayer({ playerId, platform }: GetPlayerTelemetryParams): TelemetryLookupResult {
    if (!isValidPlayerId(playerId)) {
      return { found: false, verified: false, error: `Invalid or missing playerId "${playerId}". Expected format USR-XXXX (KB-105).` };
    }
    if (!isSupportedPlatform(platform)) {
      return { found: false, verified: false, error: `Missing or unsupported platform "${platform}". Expected Steam, PS5, or Xbox (KB-105).` };
    }

    const player = this.store.getPlayerById(playerId);
    if (!player) {
      return { found: false, verified: false, error: `No telemetry profile found for playerId "${playerId.trim()}" (KB-105).` };
    }
    if (player.platform.toLowerCase() !== platform.trim().toLowerCase()) {
      return {
        found: true,
        verified: false,
        error: `Platform mismatch for ${player.playerId}: ticket specified "${platform}" but account telemetry is registered on "${player.platform}" (KB-105).`,
      };
    }
    return { found: true, verified: true, telemetry: player };
  }

  private runAction(args: ExecuteLiveOpsActionParams): LiveOpsActionResult {
    if (args.actionType === 'CREATE_P1_ESCALATION') {
      const escalationTicket = this.store.createEscalation({
        playerId: args.playerId,
        platform: args.platform,
        severity: 'P1_CRITICAL',
        reason: args.reason,
        telemetryAttached: true,
      });
      return { status: 'ESCALATION_CREATED', escalationTicket };
    }

    const grant = this.store.applyGrant(args);
    if (!grant.success) {
      return { status: 'ACTION_BLOCKED_BY_GUARDRAIL', error: grant.error };
    }
    return {
      status: 'GRANT_APPLIED',
      grantReceipt: grant.grantEntry,
      updatedBalance: grant.updatedPlayer.apexShardsBalance,
      updatedGrantedItems: grant.updatedPlayer.grantedItems,
    };
  }
}

export function createVercelAITools(executor: LiveOpsToolExecutor) {
  return {
    search_launch_kb: tool({
      description:
        'Searches the LaunchShield Day-1 Knowledge Base for edition entitlement rules (KB-101), server outage compensation caps (KB-102), anti-cheat ban rules (KB-103), critical save corruption escalation (KB-104), and player verification requirements (KB-105).',
      inputSchema: SearchLaunchKBParamsSchema,
      execute: async (args) => executor.searchLaunchKB(args),
    }),
    get_player_telemetry: tool({
      description:
        'Fetches verified player telemetry from the LiveOps store including owned edition (STANDARD/DELUXE/ULTIMATE), platform, outageOverlapMinutes, ban status, saveCorruptionFlag, and missingEntitlements.',
      inputSchema: GetPlayerTelemetryParamsSchema,
      execute: async (args) => executor.getPlayerTelemetry(args),
    }),
    execute_liveops_action: tool({
      description:
        'Executes a mutating LiveOps action in the CRUD store: either granting eligible missing entitlements / outage compensation (enforcing the 1,000 Apex Shards cap and non-banned status) or creating a P1 engineering escalation ticket.',
      inputSchema: ExecuteLiveOpsActionParamsSchema,
      execute: async (args) => executor.executeLiveOpsAction(args),
    }),
    draft_player_response: tool({
      description:
        'Drafts a structured, policy-cited player support response incorporating grant receipts or P1 escalation ticket IDs.',
      inputSchema: DraftPlayerResponseParamsSchema,
      execute: async (args) => executor.draftPlayerResponse(args),
    }),
  };
}
