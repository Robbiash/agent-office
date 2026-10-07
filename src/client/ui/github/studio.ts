// What workers are told about a Vaelmoor Studio card (Robin's fork): a task note to read, not a GitHub issue.
// The server gives Studio cards an obsidian:// URL (see src/server/studio.ts), which is how they're told apart.

/** The task note's path, when the card is a Studio task. */
export function studioFile(url: string | undefined): string | undefined {
  if (!url?.startsWith('obsidian://open?path=')) return undefined;
  return decodeURIComponent(url.slice('obsidian://open?path='.length));
}

const RULES =
  "Follow the project's AGENTS.md and CLAUDE.md, and Vaelmoor/Studio/Session Workflow.md and Team Protocol.md for how to report progress on the task. Never record Robin's verdict or acceptance yourself.";

export function studioWorkPrompt(number: number, title: string, file: string): string {
  return `Work on Vaelmoor Studio task #${number}: "${title}".\n\nRead the task record first: ${file}\nIts JSON frontmatter holds the criteria, file scopes, source notes (in the Vaelmoor vault) and where the task stands. Read the source notes it lists before changing anything.\n\n${RULES}`;
}

export function studioAskContext(number: number, title: string, file: string): string {
  return `This is about Vaelmoor Studio task #${number} "${title}". Its record is ${file} (read it and the source notes it lists).`;
}

export function studioReviewPrompt(number: number, title: string, file: string): string {
  return `Review Vaelmoor Studio task #${number}: "${title}".\n\nRead the task record (${file}) and its source notes, then check each criterion against what is actually built and the evidence. Say which criteria look met, which don't, and what Robin should look at when he tests it.\n\n${RULES}`;
}

/** The link under a card's window: to GitHub, or to the task note in Obsidian. */
export function openLinkText(url: string): string {
  return studioFile(url) ? 'Open in Obsidian ↗' : 'Open on GitHub ↗';
}
