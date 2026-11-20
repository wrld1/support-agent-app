import {
  AUTONOMOUS_SHARDS_CAP,
  isPremiumEdition,
  OUTAGE_ELIGIBILITY_MINUTES,
  STANDARD_OUTAGE_COMP_SHARDS,
  VOIDWALKER_SKIN_PACK,
} from './policy.js';
import type { CommittedAction, LiveOpsToolExecutor } from './tools.js';
import type { EscalationTicket, GrantLedgerEntry, PlayerRecord, TriageOutput, TriageRequest } from './types.js';

interface Finding {
  reasons: string[];
  citations: string[];
}

export function runDeterministicTriage(req: TriageRequest, executor: LiveOpsToolExecutor): TriageOutput {
  const text = `${req.subject} ${req.message}`;
  const kbSearch = executor.searchLaunchKB({ query: text });
  const lookup = executor.getPlayerTelemetry({ playerId: req.playerId, platform: req.platform });

  if (!lookup.verified || !lookup.telemetry) {
    return needsMoreInfo(req, lookup.error ?? 'Player telemetry could not be verified (KB-105).', executor);
  }

  const player = lookup.telemetry;
  const committed = executor.committedAction;
  if (committed) return summarizeCommitted(player, committed, executor);

  if (player.banned) return denyBanned(player, executor);

  const escalation = findEscalationNeeds(player, text);
  if (escalation.citations.length > 0) return escalate(player, escalation, executor);

  const wantsVoidwalker = /voidwalker|skin\s*pack|pre-?order|deluxe|bonus/i.test(text);
  const wantsOutageComp = /outage|shards|compensation|server|down|500/i.test(text);
  const itemToGrant =
    isPremiumEdition(player.edition) && player.missingEntitlements.includes(VOIDWALKER_SKIN_PACK)
      ? VOIDWALKER_SKIN_PACK
      : null;
  const shardsToGrant =
    wantsOutageComp && player.outageOverlapMinutes >= OUTAGE_ELIGIBILITY_MINUTES ? STANDARD_OUTAGE_COMP_SHARDS : 0;

  if (itemToGrant || shardsToGrant > 0) {
    const result = executor.executeLiveOpsAction({
      actionType: 'GRANT_ENTITLEMENT_AND_COMPENSATION',
      playerId: player.playerId,
      platform: player.platform,
      itemToGrant,
      shardsToGrant,
      policyId: grantCitations(itemToGrant, shardsToGrant).join('+'),
      reason: `Auto-resolved missing ${itemToGrant ?? 'entitlement'} and ${shardsToGrant} Apex Shards outage compensation (${player.outageOverlapMinutes}m overlap).`,
    });
    if (result.status === 'GRANT_APPLIED') {
      return autoResolve(player, result.grantReceipt, result.updatedBalance, executor);
    }
    if (result.status === 'ACTION_BLOCKED_BY_GUARDRAIL') {
      return escalate(player, { reasons: [result.error], citations: ['KB-102'] }, executor);
    }
  }

  return deny(player, findDenialReasons(player, wantsVoidwalker, wantsOutageComp, kbSearch.articles[0]?.id), executor);
}

function needsMoreInfo(req: TriageRequest, error: string, executor: LiveOpsToolExecutor): TriageOutput {
  const draft = executor.draftPlayerResponse({
    playerId: req.playerId || 'UNVERIFIED',
    gamertag: 'Player',
    decision: 'NEEDS_MORE_INFO',
    policyCitations: ['KB-105'],
    actionsSummary: error,
    receiptOrTicketId: null,
  });

  return {
    decision: 'NEEDS_MORE_INFO',
    summary: `Verification failed under KB-105: ${error}`,
    playerReply: draft.formattedReply,
    policyCitations: ['KB-105'],
    actionsTaken: [
      'Queried Launch Knowledge Base for verification & entitlement rules',
      'Attempted player telemetry verification (failed KB-105 requirements)',
      'Requested valid USR-XXXX Player ID and platform (Steam/PS5/Xbox)',
    ],
    escalationTicketId: null,
  };
}

function denyBanned(player: PlayerRecord, executor: LiveOpsToolExecutor): TriageOutput {
  const draft = executor.draftPlayerResponse({
    playerId: player.playerId,
    gamertag: player.gamertag,
    decision: 'POLICY_DENIED',
    policyCitations: ['KB-103'],
    actionsSummary: `Account ${player.playerId} carries an active EasyAntiCheat ban (${player.banReason}) and is ineligible for grants or compensation.`,
    receiptOrTicketId: null,
  });

  return {
    decision: 'POLICY_DENIED',
    summary: `Denied request for ${player.gamertag} (${player.playerId}): account is permanently banned (${player.banReason}) per KB-103.`,
    playerReply: draft.formattedReply,
    policyCitations: ['KB-103'],
    actionsTaken: [
      `Verified player telemetry for ${player.playerId} (banned: true, reason: ${player.banReason})`,
      'Denied entitlement/compensation request under Anti-Cheat Policy KB-103',
    ],
    escalationTicketId: null,
  };
}

function findEscalationNeeds(player: PlayerRecord, text: string): Finding {
  const finding: Finding = { reasons: [], citations: [] };

  if (player.saveCorruptionFlag || /save|corrupt|hash_mismatch|wipe|lost.*progress/i.test(text)) {
    finding.reasons.push(
      `Verified saveCorruptionFlag=${player.saveCorruptionFlag} on ${player.platform} (${player.playtimeHours}h playtime)`,
    );
    finding.citations.push('KB-104');
  }

  const requestedShards = Number((text.match(/(\d[\d,]*)\s*(?:apex\s*)?(?:shards|credits)/i)?.[1] ?? '0').replace(/,/g, ''));
  if (requestedShards > AUTONOMOUS_SHARDS_CAP) {
    finding.reasons.push(`Requested ${requestedShards} Apex Shards exceeds the 1,000 Apex Shards autonomous cap`);
    finding.citations.push('KB-102');
  }

  return finding;
}

function escalate(player: PlayerRecord, { reasons, citations }: Finding, executor: LiveOpsToolExecutor): TriageOutput {
  const result = executor.executeLiveOpsAction({
    actionType: 'CREATE_P1_ESCALATION',
    playerId: player.playerId,
    platform: player.platform,
    itemToGrant: null,
    shardsToGrant: 0,
    policyId: citations[0],
    reason: reasons.join('; '),
  });
  if (result.status !== 'ESCALATION_CREATED') throw new Error('Escalation ticket could not be created.');
  return escalated(player, result.escalationTicket, citations, executor);
}

function escalated(
  player: PlayerRecord,
  ticket: EscalationTicket,
  citations: string[],
  executor: LiveOpsToolExecutor,
): TriageOutput {
  const ticketId = ticket.escalationId;
  const draft = executor.draftPlayerResponse({
    playerId: player.playerId,
    gamertag: player.gamertag,
    decision: 'ESCALATED_TO_HUMAN',
    policyCitations: citations,
    actionsSummary: `${ticket.reason}. Opened P1 engineering & LiveOps Lead ticket ${ticketId} with telemetry attached`,
    receiptOrTicketId: ticketId,
  });

  return {
    decision: 'ESCALATED_TO_HUMAN',
    summary: `Escalated ${player.gamertag} (${player.playerId}) to Human LiveOps Lead & Engineering (${ticketId}): ${ticket.reason}.`,
    playerReply: draft.formattedReply,
    policyCitations: citations,
    actionsTaken: [
      `Verified telemetry for ${player.playerId} (${player.edition}, ${player.platform}, saveCorruptionFlag: ${player.saveCorruptionFlag})`,
      `Created P1 Engineering & LiveOps Lead Escalation Ticket ${ticketId}`,
      'Held automated inventory mutation pending cloud-save snapshot restoration',
    ],
    escalationTicketId: ticketId,
  };
}

function grantCitations(item: string | null, shards: number): string[] {
  return [...(item ? ['KB-101'] : []), ...(shards > 0 ? ['KB-102'] : [])];
}

function autoResolve(
  player: PlayerRecord,
  grant: GrantLedgerEntry,
  updatedBalance: number,
  executor: LiveOpsToolExecutor,
): TriageOutput {
  const citations = grantCitations(grant.itemGranted, grant.shardsGranted);
  const granted = [
    ...(grant.itemGranted ? [`granted "${grant.itemGranted}" (${player.edition} Edition)`] : []),
    ...(grant.shardsGranted > 0
      ? [`credited ${grant.shardsGranted} Apex Shards (${player.outageOverlapMinutes}m verified outage overlap)`]
      : []),
  ];

  const draft = executor.draftPlayerResponse({
    playerId: player.playerId,
    gamertag: player.gamertag,
    decision: 'AUTO_RESOLVED',
    policyCitations: citations,
    actionsSummary: `Automatically ${granted.join(' and ')}`,
    receiptOrTicketId: grant.grantId,
  });

  return {
    decision: 'AUTO_RESOLVED',
    summary: `Auto-resolved ticket for ${player.gamertag} (${player.playerId}): ${granted.join(' + ')} (Receipt: ${grant.grantId}).`,
    playerReply: draft.formattedReply,
    policyCitations: citations,
    actionsTaken: [
      `Verified ${player.playerId} telemetry: ${player.edition} Edition on ${player.platform}, ${player.outageOverlapMinutes}m outage overlap`,
      `Executed LiveOps grant ${grant.grantId}: ${granted.join(', ')}`,
      `Updated player Apex Shards balance to ${updatedBalance} and synced locker entitlements`,
    ],
    escalationTicketId: null,
  };
}

function summarizeCommitted(
  player: PlayerRecord,
  { args, result }: CommittedAction,
  executor: LiveOpsToolExecutor,
): TriageOutput {
  if (result.status === 'GRANT_APPLIED') {
    return autoResolve(player, result.grantReceipt, result.updatedBalance, executor);
  }
  return escalated(player, result.escalationTicket, args.policyId.split(/[+,\s]+/).filter(Boolean), executor);
}

function findDenialReasons(
  player: PlayerRecord,
  wantsVoidwalker: boolean,
  wantsOutageComp: boolean,
  fallbackCitation = 'KB-101',
): Finding {
  const finding: Finding = { reasons: [], citations: [] };

  if (wantsVoidwalker && !isPremiumEdition(player.edition)) {
    finding.reasons.push(
      `Account owns ${player.edition} Edition, which does not include the Deluxe/Ultimate "${VOIDWALKER_SKIN_PACK}"`,
    );
    finding.citations.push('KB-101');
  } else if (wantsVoidwalker && player.grantedItems.includes(VOIDWALKER_SKIN_PACK)) {
    finding.reasons.push(`The "${VOIDWALKER_SKIN_PACK}" is already present in the account locker`);
    finding.citations.push('KB-101');
  }

  if (wantsOutageComp && player.outageOverlapMinutes < OUTAGE_ELIGIBILITY_MINUTES) {
    finding.reasons.push(
      `Verified outage overlap is ${player.outageOverlapMinutes} minutes, below the ${OUTAGE_ELIGIBILITY_MINUTES}-minute threshold required for ${STANDARD_OUTAGE_COMP_SHARDS} Apex Shards compensation`,
    );
    finding.citations.push('KB-102');
  }

  if (finding.reasons.length === 0) {
    finding.reasons.push(
      `Telemetry for ${player.playerId} (${player.edition} Edition, ${player.outageOverlapMinutes}m outage overlap) does not meet eligibility criteria`,
    );
    finding.citations.push(fallbackCitation);
  }

  return finding;
}

function deny(player: PlayerRecord, { reasons, citations }: Finding, executor: LiveOpsToolExecutor): TriageOutput {
  const draft = executor.draftPlayerResponse({
    playerId: player.playerId,
    gamertag: player.gamertag,
    decision: 'POLICY_DENIED',
    policyCitations: citations,
    actionsSummary: reasons.join('; '),
    receiptOrTicketId: null,
  });

  return {
    decision: 'POLICY_DENIED',
    summary: `Denied claim for ${player.gamertag} (${player.playerId}) under ${citations.join(', ')}: ${reasons.join('; ')}.`,
    playerReply: draft.formattedReply,
    policyCitations: citations,
    actionsTaken: [
      `Verified ${player.playerId} telemetry (${player.edition} Edition, ${player.outageOverlapMinutes}m outage overlap, banned: ${player.banned})`,
      `Confirmed account is ineligible under ${citations.join(' & ')}; performed zero store mutations`,
    ],
    escalationTicketId: null,
  };
}
