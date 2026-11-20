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
    pattern: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions|policies|rules)/i,
    label: 'PROMPT_INJECTION_OVERRIDE',
  },
  {
    pattern: /(?:system\s+override|developer\s+root\s+mode|admin\s+diagnostic\s+mode|jailbreak)/i,
    label: 'PRIVILEGE_ESCALATION_ATTEMPT',
  },
  {
    pattern: /\bunban\b/i,
    label: 'PROHIBITED_UNBAN_COMMAND',
  },
  {
    pattern: /(?:99,?999|bypass(?:ing)?\s+the\s+1000\s+cap|mint\s+currency)/i,
    label: 'OVER_CAP_EXPLOIT_DEMAND',
  },
  {
    pattern: /(?:unreleased\s+dlc|confidential.*roadmap|leak.*roadmap|system\s+prompt)/i,
    label: 'CONFIDENTIAL_DATA_EXFILTRATION',
  },
];

export function evaluateInputSafety(
  text: string,
  rules: readonly SecurityRule[] = DEFAULT_SECURITY_RULES,
): GuardrailInspection {
  const violations = rules.filter((rule) => rule.pattern.test(text)).map((rule) => rule.label);
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
