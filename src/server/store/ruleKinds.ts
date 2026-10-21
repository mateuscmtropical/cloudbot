const RULE_KINDS = ['allow', 'block'] as const;

type RuleKind = typeof RULE_KINDS[number];

export { RULE_KINDS };
export type { RuleKind };
