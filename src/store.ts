import { createInitialPlayers, KB_ARTICLES } from './data.js';
import {
  AUTONOMOUS_SHARDS_CAP,
  isPremiumEdition,
  OUTAGE_ELIGIBILITY_MINUTES,
} from './policy.js';
import type {
  ApplyGrantParams,
  ApplyGrantResult,
  CreateEscalationParams,
  EscalationTicket,
  GrantLedgerEntry,
  KBArticle,
  PlayerRecord,
  StoreSnapshot,
} from './types.js';

export class LiveOpsStore {
  private players: PlayerRecord[] = createInitialPlayers();
  private grants: GrantLedgerEntry[] = [];
  private escalations: EscalationTicket[] = [];

  reset(): StoreSnapshot {
    this.players = createInitialPlayers();
    this.grants = [];
    this.escalations = [];
    return this.getSnapshot();
  }

  getSnapshot(): StoreSnapshot {
    return structuredClone({
      players: this.players,
      grants: this.grants,
      escalations: this.escalations,
      kbArticles: [...KB_ARTICLES],
    });
  }

  searchKB(query: string, category?: string): KBArticle[] {
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9-]+/)
      .filter((t) => t.length >= 2);

    const scored = KB_ARTICLES.map((article) => {
      const haystack = [article.id, article.title, article.summary, ...article.rules, ...article.keywords]
        .join(' ')
        .toLowerCase();
      let score = category?.toLowerCase() === article.category.toLowerCase() ? 5 : 0;
      for (const term of terms) {
        if (article.keywords.some((k) => k.includes(term))) score += 3;
        else if (haystack.includes(term)) score += 1;
      }
      return { article, score };
    });

    const matched = scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.article);

    return matched.length > 0 ? matched : KB_ARTICLES.slice(0, 3);
  }

  getPlayerById(playerId: string): PlayerRecord | undefined {
    const normalized = playerId.trim().toUpperCase();
    return this.players.find((p) => p.playerId === normalized);
  }

  getGrantedShards(playerId: string): number {
    return this.grants
      .filter((g) => g.playerId === playerId)
      .reduce((sum, g) => sum + g.shardsGranted, 0);
  }

  applyGrant(params: ApplyGrantParams): ApplyGrantResult {
    const player = this.getPlayerById(params.playerId);
    if (!player) {
      return { success: false, error: `Player ${params.playerId} not found in telemetry store.` };
    }

    const item = params.itemToGrant ?? null;
    const shards = params.shardsToGrant ?? 0;
    const blocked = this.findGrantViolation(player, item, shards);
    if (blocked) {
      return { success: false, error: `GUARDRAIL_BLOCKED: ${blocked}` };
    }

    if (item) {
      if (!player.grantedItems.includes(item)) player.grantedItems.push(item);
      player.missingEntitlements = player.missingEntitlements.filter(
        (missing) => missing.toLowerCase() !== item.toLowerCase(),
      );
    }
    player.apexShardsBalance += shards;

    const grantEntry: GrantLedgerEntry = {
      grantId: `GRT-${101 + this.grants.length}`,
      playerId: player.playerId,
      itemGranted: item,
      shardsGranted: shards,
      reason: params.reason,
      policyId: params.policyId,
      timestamp: new Date().toISOString(),
    };
    this.grants.push(grantEntry);

    return { success: true, grantEntry, updatedPlayer: structuredClone(player) };
  }

  createEscalation(params: CreateEscalationParams): EscalationTicket {
    const ticket: EscalationTicket = {
      escalationId: `P1-ESC-${901 + this.escalations.length}`,
      ...params,
      platform: params.platform || 'Unknown',
      timestamp: new Date().toISOString(),
    };
    this.escalations.push(ticket);
    return ticket;
  }

  private findGrantViolation(player: PlayerRecord, item: string | null, shards: number): string | null {
    const id = player.playerId;
    if (player.banned) {
      return `Account ${id} is banned (${player.banReason}). Per KB-103, banned accounts are strictly ineligible for grants or compensation.`;
    }
    if (player.saveCorruptionFlag) {
      return `Account ${id} has an active saveCorruptionFlag. Per KB-104, open a P1 escalation ticket instead of mutating inventory.`;
    }
    const cumulative = this.getGrantedShards(id) + shards;
    if (shards < 0 || cumulative > AUTONOMOUS_SHARDS_CAP) {
      return `Requested ${shards} Apex Shards (cumulative ${cumulative}) exceeds the 1,000 Apex Shards autonomous cap (KB-102). Must escalate to Human LiveOps Lead.`;
    }
    if (item?.toLowerCase().includes('voidwalker') && !isPremiumEdition(player.edition)) {
      return `Player ${id} owns ${player.edition} edition and is ineligible for Deluxe/Ultimate item "${item}" (KB-101).`;
    }
    if (shards > 0 && player.outageOverlapMinutes < OUTAGE_ELIGIBILITY_MINUTES) {
      return `Player ${id} only has ${player.outageOverlapMinutes}m outage overlap (< ${OUTAGE_ELIGIBILITY_MINUTES}m threshold required by KB-102).`;
    }
    return null;
  }
}
