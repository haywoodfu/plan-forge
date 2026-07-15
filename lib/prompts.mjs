import fsp from 'node:fs/promises';
import path from 'node:path';

async function read(file) {
  return fsp.readFile(file, 'utf8');
}

function block(name, content) {
  return `\n===== BEGIN ${name} =====\n${String(content ?? '').trim()}\n===== END ${name} =====\n`;
}

export async function loadPromptTemplates(toolRoot) {
  const directory = path.join(toolRoot, 'prompts');
  const [shared, author, revise, reviewer] = await Promise.all([
    read(path.join(directory, 'shared-policy.md')),
    read(path.join(directory, 'author.md')),
    read(path.join(directory, 'revise.md')),
    read(path.join(directory, 'reviewer.md'))
  ]);
  return { shared, author, revise, reviewer };
}

function sanitizedFinding(finding) {
  return {
    id: finding.id,
    severity: finding.effectiveSeverity,
    category: finding.category,
    planSection: finding.planSection,
    problem: finding.problem,
    evidence: finding.evidence,
    requiredChange: finding.requiredChange,
    criticalReviewStreak: finding.criticalReviewStreak
  };
}

function closedFindingHistory(finding) {
  return {
    id: finding.id,
    severity: finding.effectiveSeverity,
    category: finding.category,
    planSection: finding.planSection,
    problem: finding.problem,
    requiredChange: finding.requiredChange,
    closedAs: finding.lastStatus,
    closedInRound: finding.lastReviewedRound,
    closingExplanation: finding.lastExplanation
  };
}

export function buildAuthorPrompt({ templates, agentsMd, requirement, previousPlan, findings, overrides }) {
  const role = previousPlan ? templates.revise : templates.author;
  const parts = [
    block('WORKFLOW POLICY', templates.shared),
    block('ROLE', role),
    block('PROJECT AGENTS.MD', agentsMd),
    block('FROZEN REQUIREMENT', requirement)
  ];
  if (previousPlan) parts.push(block('PREVIOUS PLAN', previousPlan));
  parts.push(block('ACTIVE FINDINGS', JSON.stringify(findings.map(sanitizedFinding), null, 2)));
  parts.push(block('HUMAN OVERRIDES', JSON.stringify(overrides.entries || [], null, 2)));
  return parts.join('');
}

export function buildReviewerPrompt({ templates, agentsMd, requirement, plan, findings, closedFindings = [], resolutions, overrides }) {
  return [
    block('WORKFLOW POLICY', templates.shared),
    block('ROLE', templates.reviewer),
    block('PROJECT AGENTS.MD', agentsMd),
    block('FROZEN REQUIREMENT', requirement),
    block('CURRENT PLAN', plan),
    block('ACTIVE FINDINGS TO DISPOSITION', JSON.stringify(findings.map(sanitizedFinding), null, 2)),
    block('CLOSED FINDINGS', JSON.stringify(closedFindings.map(closedFindingHistory), null, 2)),
    block('AUTHOR RESOLUTIONS', JSON.stringify(resolutions, null, 2)),
    block('HUMAN OVERRIDES FOR AUDIT ONLY', JSON.stringify(overrides.entries || [], null, 2))
  ].join('');
}
