export type NotionTemplateId = 'idea' | 'research' | 'experiment' | 'conclusion'
export interface NotionTemplate {
  id: NotionTemplateId
  name: string
  description: string
  icon: string
  color: string
  sections: string[]
  content: string
}

// These are native Notion blocks, not HTML artifacts. The published template
// pages remain editable; record creation reads the current Notion template.
export const notionTemplates: NotionTemplate[] = [
  {
    id: 'idea', name: 'Idea', icon: '💡', color: 'amber',
    description: 'Give a promising thought a clear question and a small next step.',
    sections: ['The thought', 'Why it matters', 'A small test', 'Open questions'],
    content: `<span color="gray">FIELD NOTES / IDEA</span>
> One useful thought. One question worth exploring.
## The thought
*Describe the idea in a few sentences. What could become possible?*
<columns>
	<column ratio="50">
		### The friction
		*What is difficult today? Who experiences it?*
	</column>
	<column ratio="50">
		### The possibility
		*What would a better outcome look like?*
	</column>
</columns>
## A small test
- [ ] State the assumption that matters most.
- [ ] Choose the smallest useful prototype or observation.
- [ ] Define what would make the idea worth pursuing.
## Open questions
*Keep unresolved questions here. Uncertainty is part of the record.*
---
**Next move**
*One action, with a clear stopping point.*`,
  },
  {
    id: 'research', name: 'Research note', icon: '📖', color: 'blue',
    description: 'Separate what a source claims from what you think it means.',
    sections: ['Reading question', 'Source & claims', 'Evidence & limits', 'Implications'],
    content: `<span color="gray">FIELD NOTES / RESEARCH</span>
> Read for a question, not just a summary.
## Reading question
*What are you trying to understand or decide?*
**Source**
*Title · author · year · link. Keep exact citations next to the claims they support.*
<columns>
	<column ratio="50">
		### What the source says
		*Record the main claims and the evidence offered for them.*
	</column>
	<column ratio="50">
		### My interpretation
		*Separate your inference from the source's own conclusions.*
	</column>
</columns>
## Evidence and limits
<table header-row="true">
	<tr><td>Claim or observation</td><td>Evidence / location</td><td>Limitation</td></tr>
	<tr><td>To investigate</td><td>Source needed</td><td>Not assessed</td></tr>
</table>
## What this changes
*How does this inform the project? What does it leave unresolved?*
---
**Next move**
- [ ] Follow one important citation or reproduce one key observation.
- [ ] Link any resulting experiment or conclusion.`,
  },
  {
    id: 'experiment', name: 'Experiment', icon: '🧪', color: 'sage',
    description: 'Plan a fair test, keep the run details, and make the result reproducible.',
    sections: ['Hypothesis', 'Protocol', 'Run log', 'Result & next test'],
    content: `<span color="gray">LAB NOTES / EXPERIMENT</span>
> A prediction, a reproducible test, and an honest result.
<columns>
	<column ratio="50">
		### Hypothesis
		*If we change X, we expect Y, because…*
	</column>
	<column ratio="50">
		### Decision rule
		*What observation would support or challenge this prediction?*
	</column>
</columns>
## Protocol
<table header-row="true">
	<tr><td>Keep reproducible</td><td>Record before running</td></tr>
	<tr><td>Code / revision</td><td>Commit, branch, or exact version</td></tr>
	<tr><td>Data / environment</td><td>Dataset, inputs, hardware, and dependencies</td></tr>
	<tr><td>Baseline / control</td><td>What stays the same?</td></tr>
	<tr><td>Parameters / seed</td><td>Changed settings and random seed, if relevant</td></tr>
	<tr><td>Metric / threshold</td><td>How the outcome will be judged</td></tr>
</table>
## Run log
<table header-row="true">
	<tr><td>Run / date</td><td>Change</td><td>Observation</td><td>Evidence</td></tr>
	<tr><td>Not run yet</td><td>To define</td><td>No result recorded</td><td>Log or artifact link</td></tr>
</table>
## Result
*Supported, not supported, or inconclusive? Explain what was actually observed and which confounders remain.*
## Conclusion
*What can be concluded within this test's scope? Do not turn an untested assumption into a finding.*
---
**Next move**
*Continue, change the approach, or stop. Name the next discriminating test.*`,
  },
  {
    id: 'conclusion', name: 'Conclusion', icon: '📌', color: 'violet',
    description: 'Keep the decision, its supporting evidence, and when to revisit it.',
    sections: ['Finding', 'Evidence', 'Confidence & scope', 'Decision'],
    content: `<span color="gray">RESEARCH RECORD / CONCLUSION</span>
> A conclusion should stay connected to the evidence that earned it.
## Finding
*State the conclusion plainly. Keep it narrower than the evidence, not broader.*
<columns>
	<column ratio="50">
		### Supporting evidence
		*Link the research notes, runs, and observations that support the finding.*
	</column>
	<column ratio="50">
		### Counter-evidence
		*What does not fit? What alternatives are still plausible?*
	</column>
</columns>
## Confidence and scope
**Confidence:** *Not assessed yet.*
**Applies to:** *Conditions, population, inputs, or environment tested.*
**Does not establish:** *Important limits or untested cases.*
## Decision
*What will we do differently because of this finding?*
---
**Revisit when**
*Name the new evidence or condition that would change the decision.*
**Next move**
*One concrete follow-up, or an explicit decision to stop.*`,
  },
]

export function escapeNotionText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/([*~`$[\]<>{}|^])/g, '\\$1')
}

export function notionRecordContent(template: string, note: string, source: string): string {
  const parts: string[] = []
  if (note.trim()) parts.push(`**Starting note**\n${escapeNotionText(note.trim())}`)
  if (source.trim()) {
    const url = new URL(source.trim())
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP or HTTPS source link without credentials')
    // A plain escaped URL cannot inject Notion blocks or Markdown link syntax.
    parts.push(`**Source**\n${escapeNotionText(url.href)}`)
  }
  return [...parts, ...(parts.length ? ['---'] : []), template].join('\n')
}
