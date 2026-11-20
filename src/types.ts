import { z } from 'zod';

export const DecisionCategorySchema = z.enum([
  'AUTO_RESOLVED',
  'POLICY_DENIED',
  'ESCALATED_TO_HUMAN',
  'NEEDS_MORE_INFO',
  'SECURITY_REFUSAL',
]);

export const KBCategorySchema = z.enum([
  'ENTITLEMENT',
  'OUTAGE_COMPENSATION',
  'ANTI_CHEAT',
  'CRITICAL_BUG',
  'VERIFICATION',
]);

export type DecisionCategory = z.infer<typeof DecisionCategorySchema>;
export type KBCategory = z.infer<typeof KBCategorySchema>;
export type ExecutionMode = 'vercel-ai-sdk' | 'deterministic-fallback';
export type EditionType = 'STANDARD' | 'DELUXE' | 'ULTIMATE';
export type PlatformType = 'Steam' | 'PS5' | 'Xbox';
export type EscalationSeverity = 'P1_CRITICAL' | 'P2_HIGH_VALUE';

export const TriageRequestSchema = z.object({
  ticketId: z.string().max(64).optional(),
  playerId: z.string().max(64).default(''),
  platform: z.string().max(32).default(''),
  subject: z.string().max(300).default('Support Request'),
  message: z.string().max(8000).default(''),
});

export type TriageRequest = z.infer<typeof TriageRequestSchema>;

export const TriageOutputSchema = z.object({
  decision: DecisionCategorySchema,
  summary: z.string(),
  playerReply: z.string(),
  policyCitations: z.array(z.string()),
  actionsTaken: z.array(z.string()),
  escalationTicketId: z.string().nullable(),
});

export type TriageOutput = z.infer<typeof TriageOutputSchema>;

export const SearchLaunchKBParamsSchema = z.object({
  query: z.string().describe('Keywords or issue description to search in the Launch Knowledge Base'),
  category: KBCategorySchema.optional().describe('Optional policy category filter'),
});

export const GetPlayerTelemetryParamsSchema = z.object({
  playerId: z.string().describe('Player ID in format USR-XXXX'),
  platform: z.string().describe('Gaming platform (Steam, PS5, Xbox)'),
});

export const ExecuteLiveOpsActionParamsSchema = z.object({
  actionType: z
    .enum(['GRANT_ENTITLEMENT_AND_COMPENSATION', 'CREATE_P1_ESCALATION'])
    .describe('Whether to grant items/shards in the CRUD store or create a P1 engineering escalation ticket'),
  playerId: z.string().describe('Target player ID (USR-XXXX)'),
  platform: z.string().describe('Player platform (Steam, PS5, Xbox)'),
  itemToGrant: z.string().nullable().describe('Item entitlement to grant (e.g., "Voidwalker Skin Pack") or null'),
  shardsToGrant: z.number().int().describe('Amount of Apex Shards compensation to grant (must be <= 1000 cap, or 0)'),
  policyId: z.string().describe('Primary Launch KB policy ID authorizing this action (e.g., KB-101, KB-102, KB-104)'),
  reason: z.string().describe('Audit log reason or P1 escalation summary'),
});

export const DraftPlayerResponseParamsSchema = z.object({
  playerId: z.string().describe('Player ID or identifier'),
  gamertag: z.string().describe('Player gamertag or display name'),
  decision: DecisionCategorySchema.describe('Final triage decision category'),
  policyCitations: z.array(z.string()).describe('List of Launch KB policy IDs cited (e.g., ["KB-101", "KB-102"])'),
  actionsSummary: z.string().describe('Summary of actions performed or reason for denial/escalation'),
  receiptOrTicketId: z
    .string()
    .nullable()
    .describe('Grant receipt ID (GRT-XXX) or P1 Escalation Ticket ID (P1-ESC-XXX) if applicable'),
});

export type SearchLaunchKBParams = z.infer<typeof SearchLaunchKBParamsSchema>;
export type GetPlayerTelemetryParams = z.infer<typeof GetPlayerTelemetryParamsSchema>;
export type ExecuteLiveOpsActionParams = z.infer<typeof ExecuteLiveOpsActionParamsSchema>;
export type DraftPlayerResponseParams = z.infer<typeof DraftPlayerResponseParamsSchema>;

export interface ToolTraceStep {
  step: number;
  toolName: string;
  args: object;
  result: unknown;
  durationMs: number;
  timestamp: string;
}

export interface PlayerRecord {
  playerId: string;
  gamertag: string;
  edition: EditionType;
  platform: PlatformType;
  playtimeHours: number;
  outageOverlapMinutes: number;
  banned: boolean;
  banReason: string | null;
  saveCorruptionFlag: boolean;
  grantedItems: string[];
  apexShardsBalance: number;
  missingEntitlements: string[];
}

export interface KBArticle {
  id: string;
  title: string;
  category: KBCategory;
  summary: string;
  rules: string[];
  keywords: string[];
}

export interface GrantLedgerEntry {
  grantId: string;
  playerId: string;
  itemGranted: string | null;
  shardsGranted: number;
  reason: string;
  policyId: string;
  timestamp: string;
}

export interface EscalationTicket {
  escalationId: string;
  playerId: string;
  platform: string;
  severity: EscalationSeverity;
  reason: string;
  telemetryAttached: boolean;
  timestamp: string;
}

export interface ScenarioPreset {
  id: string;
  title: string;
  badge: string;
  expectedDecision: DecisionCategory;
  description: string;
  ticket: Pick<TriageRequest, 'playerId' | 'platform' | 'subject' | 'message'>;
}

export interface StoreSnapshot {
  players: PlayerRecord[];
  grants: GrantLedgerEntry[];
  escalations: EscalationTicket[];
  kbArticles: KBArticle[];
}

export interface TriageResponse {
  ticketId: string;
  executionMode: ExecutionMode;
  output: TriageOutput;
  traces: ToolTraceStep[];
  totalDurationMs: number;
  store: StoreSnapshot;
}

export interface ApplyGrantParams {
  playerId: string;
  itemToGrant?: string | null;
  shardsToGrant?: number;
  reason: string;
  policyId: string;
}

export type ApplyGrantResult =
  | { success: true; grantEntry: GrantLedgerEntry; updatedPlayer: PlayerRecord }
  | { success: false; error: string };

export interface CreateEscalationParams {
  playerId: string;
  platform: string;
  severity: EscalationSeverity;
  reason: string;
  telemetryAttached: boolean;
}
