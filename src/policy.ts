import type { EditionType } from './types.js';

export const AUTONOMOUS_SHARDS_CAP = 1000;
export const OUTAGE_ELIGIBILITY_MINUTES = 60;
export const STANDARD_OUTAGE_COMP_SHARDS = 500;
export const VOIDWALKER_SKIN_PACK = 'Voidwalker Skin Pack';

const PREMIUM_EDITIONS: readonly EditionType[] = ['DELUXE', 'ULTIMATE'];
const SUPPORTED_PLATFORMS = ['steam', 'ps5', 'xbox'];

export const isValidPlayerId = (playerId: string) => /^USR-\d{4}$/i.test(playerId.trim());

export const isSupportedPlatform = (platform: string) =>
  SUPPORTED_PLATFORMS.includes(platform.trim().toLowerCase());

export const isPremiumEdition = (edition: EditionType) => PREMIUM_EDITIONS.includes(edition);
