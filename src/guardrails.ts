import type { TraceRecorder } from './trace.js';

export const SAFETY_GUARDRAIL_NAME = 'LaunchShieldSafetyInputGuardrail';

export interface SecurityRule {
  pattern: RegExp;
  label: string;
}

export interface GuardrailInspection {
  tripwireTriggered: boolean;
  violations: string[];
  reason: string;
}

export const DEFAULT_SECURITY_RULES: readonly SecurityRule[] = [
  {
    pattern:
      /\b(?:ignore|disregard|forget|override|bypass)\b[^.!?\n]{0,40}\b(?:instructions?|rules|policies|prompts?|guidelines)\b|\bforget\s+everything\b|\bnew\s+(?:instructions|rules)\s+from\b/i,
    label: 'PROMPT_INJECTION_OVERRIDE',
  },
  {
    pattern:
      /\b(?:system\s+override|developer\s+(?:root\s+)?mode|root\s+mode|admin(?:istrator)?\s+(?:diagnostic\s+)?mode|jailbreak|you\s+are\s+(?:now\s+)?(?:dan|in\s+\w+\s+mode|an?\s+(?:unrestricted|unfiltered)\b)|act\s+as\s+(?:an?\s+|the\s+)?(?:admin|administrator|developer|system|game\s+master))/i,
    label: 'PRIVILEGE_ESCALATION_ATTEMPT',
  },
  {
    pattern: /\b(?:immediately|now|asap|i\s+demand|you\s+must)\b[^.!?\n]{0,20}\bun-?ban\b|\bun-?ban\b[^.!?\n]{0,30}\b(?:immediately|right\s+now|asap)\b/i,
    label: 'PROHIBITED_UNBAN_COMMAND',
  },
  {
    pattern:
      /\b(?:\d{2,3}[,.\s]?\d{3}|\d{6,})(?:\s+\w+){0,2}?\s+(?:apex\s+)?(?:shards|credits|coins|currency)\b|\b(?:bypass(?:ing)?|around|ignor(?:e|ing)|overrid(?:e|ing)|skip(?:ping)?)\s+the\s+(?:1,?000\s+|thousand\s+|autonomous\s+)?(?:shards?\s+)?cap\b|\bmint(?:ing)?\s+(?:currency|shards|credits)\b/i,
    label: 'OVER_CAP_EXPLOIT_DEMAND',
  },
  {
    pattern:
      /\b(?:reveal|print|show|output|leak|repeat|dump|tell\s+me|give\s+me)\b[^.!?\n]{0,40}\b(?:system\s+prompt|hidden\s+instructions|your\s+(?:full\s+|original\s+)?(?:prompt|instructions))\b|\b(?:unreleased|confidential|internal)\s+(?:dlc|roadmap)\b/i,
    label: 'CONFIDENTIAL_DATA_EXFILTRATION',
  },
];

const LOOKALIKES: Record<string, string> = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i',
  А: 'A', Е: 'E', О: 'O', Р: 'P', С: 'C', Х: 'X', І: 'I',
};

export function normalizeForInspection(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[­​-‏⁠﻿]/g, '')
    .replace(/[аеорсухіАЕОРСХІ]/g, (ch) => LOOKALIKES[ch])
    .replace(/\s+/g, ' ');
}

export function evaluateInputSafety(
  text: string,
  rules: readonly SecurityRule[] = DEFAULT_SECURITY_RULES,
): GuardrailInspection {
  const normalized = normalizeForInspection(text);
  const violations = rules.filter((rule) => rule.pattern.test(normalized)).map((rule) => rule.label);
  const tripwireTriggered = violations.length > 0;
  return {
    tripwireTriggered,
    violations,
    reason: tripwireTriggered
      ? `Blocked adversarial request triggering security rules: ${violations.join(', ')}`
      : 'Input passed security and prompt-injection checks.',
  };
}

export function inspectInput(text: string, trace: TraceRecorder): GuardrailInspection {
  return trace.record(`input_guardrail:${SAFETY_GUARDRAIL_NAME}`, { inputPreview: text.slice(0, 180) }, () =>
    evaluateInputSafety(text),
  );
}
