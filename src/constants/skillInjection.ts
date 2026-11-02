/**
 * The tentative-skill injection ceiling, shared by the full-body retrieval and
 * the skills index. Two is deliberate: a tentative rule is context, not a
 * rulebook, and a prompt carrying many unconfirmed hypotheses would drown the
 * measured skills beside them.
 */
export const TENTATIVE_SKILL_INJECTION_MAX = 2;
