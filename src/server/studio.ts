// A floor's boards read from a Vaelmoor Studio folder instead of GitHub (Robin's fork).
//
// Studio keeps one Markdown note per task under <studio>/Tasks, its frontmatter a JSON record (see
// VaelmoorStudio's src/contracts/records.ts). The issues board shows every task; the PR board shows the
// ones that are built and waiting on, or past, Robin's verdict. Studio stays the only source of truth:
// the office never writes its files. Comments go through Studio's own API (the one write Studio allows),
// and the board's other GitHub actions (label, merge, close) say they can't.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GhCloseReason, GhComment, GhIssue, GhIssueDetail, GhLabel, GhMergeMethod, GhPull, GhPullDetail, GhRepoInfo, GhState } from '../shared/protocol.js';
import { Claims, type GitHub } from './github.js';
import type { GhAs } from './signins.js';

/** What the rest of the office uses of a floor's boards: GitHub's, or Studio's. */
export type Boards = { [K in keyof GitHub]: GitHub[K] };

/** Studio notes are re-read this often; it's a folder on disk, so cheaply. */
const REFRESH_MS = 10_000;
const READ_ONLY = 'Studio tasks are read-only in the office. Change the task in Obsidian (Vaelmoor/Studio/Tasks), and the board follows within seconds.';

/** Where the Studio app runs, and the command that starts it when it isn't (it never stops anything). */
export interface StudioServer {
  url: string;
  ensure?: string[];
}

/** A floors.json studioServer entry, if it is one. */
export function studioServerOf(raw: any): StudioServer | undefined {
  if (typeof raw?.url !== 'string') return undefined;
  const ensure = Array.isArray(raw.ensure) && raw.ensure.length && raw.ensure.every((x: unknown) => typeof x === 'string') ? (raw.ensure as string[]) : undefined;
  return { url: raw.url, ...(ensure ? { ensure } : {}) };
}

/** A comment file under Studio/Comments, as Studio saves it (src/vault/comments.ts there). */
interface StudioComment {
  id: string;
  target: { key: string; sourcePath: string };
  text: string;
  quote: string;
  createdAt: string;
  author: string;
}

type Stage = 'planned' | 'ready' | 'working' | 'verifying' | 'awaiting_robin' | 'done' | 'blocked';

interface Criterion {
  id: string;
  text: string;
  requiresRobin?: boolean;
}

/** A task note's frontmatter, as much of it as the boards show. */
interface StudioTask {
  id: string;
  title: string;
  projectId: string;
  sourceNotes?: string[];
  dependsOn?: string[];
  fileScopes?: string[];
  criteria?: Criterion[];
  reported: {
    stage: Stage;
    label: string;
    summary: string;
    asOf: string;
    built: boolean;
    tested: boolean;
    verdict: 'pending' | 'accepted' | 'changes_requested' | 'not_required';
    owner?: string;
    blocker?: string;
  };
}

interface Loaded {
  task: StudioTask;
  file: string;
  number: number;
  updatedAt: string;
}

const STAGE_LABELS: Record<Stage, GhLabel> = {
  planned: { name: '🗒️ planned', color: '#9aa0a6' },
  ready: { name: '🟢 ready', color: '#2da44e' },
  working: { name: '🚧 working', color: '#d29922' },
  verifying: { name: '🔬 verifying', color: '#bf8700' },
  awaiting_robin: { name: '⏳ awaiting Robin', color: '#8250df' },
  done: { name: '✅ done', color: '#1f6feb' },
  blocked: { name: '🚫 blocked', color: '#cf222e' },
};

/** The JSON record between a note's opening and closing `---` lines. */
export function frontmatter(text: string): unknown {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text);
  if (!m) throw new Error('no frontmatter');
  return JSON.parse(m[1]);
}

/** A link that opens the note in Obsidian (the vault is registered there). */
export function obsidianUrl(file: string): string {
  return `obsidian://open?path=${encodeURIComponent(file)}`;
}

function isTask(r: any): r is StudioTask {
  return r && r.type === 'task' && typeof r.id === 'string' && typeof r.title === 'string' && r.reported && typeof r.reported.stage === 'string' && r.reported.stage in STAGE_LABELS;
}

/** The card's description: where the task stands, what counts as done, and where to read more. */
export function taskBody(t: StudioTask, file: string): string {
  const r = t.reported;
  const lines = [`**${r.label}** (as of ${r.asOf})`, '', r.summary];
  if (r.blocker) lines.push('', `**Blocked:** ${r.blocker}`);
  lines.push('', `Built: ${r.built ? 'yes' : 'no'} · Tested: ${r.tested ? 'yes' : 'no'} · Verdict: ${r.verdict.replace('_', ' ')}${r.owner ? ` · Owner: ${r.owner}` : ''}`);
  if (t.criteria?.length) lines.push('', '### Criteria', ...t.criteria.map((c) => `- ${c.text}${c.requiresRobin === false ? '' : ' *(Robin checks)*'}`));
  if (t.dependsOn?.length) lines.push('', `**Depends on:** ${t.dependsOn.join(', ')}`);
  if (t.sourceNotes?.length) lines.push('', '### Source notes', ...t.sourceNotes.map((n) => `- ${n}`));
  if (t.fileScopes?.length) lines.push('', '### Files', ...t.fileScopes.map((f) => `- \`${f}\``));
  lines.push('', `Task record: \`${file}\``);
  return lines.join('\n');
}

/** The PR board's columns, from where the task stands with Robin. */
function pullState(r: StudioTask['reported']): Pick<GhPull, 'state' | 'isDraft' | 'reviewDecision'> {
  if (r.stage === 'done') return { state: 'MERGED', isDraft: false, reviewDecision: 'APPROVED' };
  if (r.stage === 'verifying') return { state: 'OPEN', isDraft: true, reviewDecision: '' };
  if (r.verdict === 'accepted') return { state: 'OPEN', isDraft: false, reviewDecision: 'APPROVED' };
  return { state: 'OPEN', isDraft: false, reviewDecision: r.verdict === 'changes_requested' ? 'CHANGES_REQUESTED' : '' };
}

export class StudioBoards implements Boards {
  issues: GhState<GhIssue> = { items: [], fetchedAt: 0, loading: false };
  pulls: GhState<GhPull> = { items: [], fetchedAt: 0, loading: false };
  private timer?: NodeJS.Timeout;
  private claims = new Claims();
  private tasks: Loaded[] = [];
  private projects = new Map<string, string>();
  /** Task id → its card number, kept so a card keeps its number as tasks come and go. */
  private numbers: Record<string, number> = {};
  private numbersFile: string;
  /** Studio comments by the vault path of the note they're on ("Studio/Tasks/x.md"). */
  private comments = new Map<string, StudioComment[]>();
  /** The vault Studio lives in: Studio's paths are relative to it. */
  private vault: string;

  constructor(
    private studio: string,
    dataDir: string,
    private onIssues: (s: GhState<GhIssue>) => void,
    private onPulls: (s: GhState<GhPull>) => void,
    private server: StudioServer = { url: 'http://127.0.0.1:4317' },
  ) {
    this.vault = path.dirname(studio);
    this.numbersFile = path.join(dataDir, 'studio-numbers.json');
    try {
      this.numbers = JSON.parse(readFileSync(this.numbersFile, 'utf8'));
    } catch {
      this.numbers = {};
    }
  }

  start() {
    // Comments are posted through the Studio app, so have it running before anyone needs it.
    void this.ensure().catch((err) => console.error(`agent-office: Vaelmoor Studio didn't start: ${(err as Error).message}`));
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
  }

  stop() {
    clearInterval(this.timer);
  }

  async refresh() {
    let error: string | undefined;
    try {
      this.read();
    } catch (err) {
      error = `Couldn't read the Studio at ${this.studio}: ${(err as Error).message}`;
    }
    const at = Date.now();
    this.issues = { items: this.claims.mark(this.issueCards()), fetchedAt: at, loading: false, error };
    this.pulls = { items: this.pullCards(), fetchedAt: at, loading: false, error };
    this.onIssues(this.issues);
    this.onPulls(this.pulls);
  }

  private read() {
    this.projects.clear();
    const projectsDir = path.join(this.studio, 'Projects');
    for (const f of existsSync(projectsDir) ? readdirSync(projectsDir) : []) {
      if (!f.endsWith('.md')) continue;
      try {
        const p: any = frontmatter(readFileSync(path.join(projectsDir, f), 'utf8'));
        if (p?.type === 'project' && typeof p.id === 'string') this.projects.set(p.id, String(p.title ?? p.id));
      } catch {
        // A project note that doesn't parse only loses its name on the cards.
      }
    }
    const tasksDir = path.join(this.studio, 'Tasks');
    const tasks: Loaded[] = [];
    let added = false;
    for (const f of readdirSync(tasksDir).sort()) {
      if (!f.endsWith('.md')) continue;
      const file = path.join(tasksDir, f);
      let task: unknown;
      try {
        task = frontmatter(readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      if (!isTask(task)) continue;
      if (!this.numbers[task.id]) {
        this.numbers[task.id] = Math.max(0, ...Object.values(this.numbers)) + 1;
        added = true;
      }
      const asOf = /^\d{4}-\d{2}-\d{2}$/.test(task.reported.asOf) ? `${task.reported.asOf}T12:00:00Z` : statSync(file).mtime.toISOString();
      tasks.push({ task, file, number: this.numbers[task.id], updatedAt: asOf });
    }
    if (added) writeFileSync(this.numbersFile, JSON.stringify(this.numbers, null, 2));
    this.tasks = tasks;
    this.readComments();
  }

  private readComments() {
    this.comments.clear();
    const dir = path.join(this.studio, 'Comments');
    for (const f of existsSync(dir) ? readdirSync(dir) : []) {
      if (!/^[-a-f0-9]{36}\.md$/.test(f)) continue;
      try {
        const c = frontmatter(readFileSync(path.join(dir, f), 'utf8')) as StudioComment;
        if (typeof c?.text !== 'string' || typeof c.target?.sourcePath !== 'string') continue;
        const list = this.comments.get(c.target.sourcePath) ?? [];
        list.push(c);
        this.comments.set(c.target.sourcePath, list);
      } catch {
        // Studio shows its own warning for a comment file it can't read.
      }
    }
    for (const list of this.comments.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** The Studio comments on a task's note, as the board shows comments. */
  private commentsOn(file: string): GhComment[] {
    return (this.comments.get(path.relative(this.vault, file)) ?? []).map((c) => ({
      id: c.id,
      author: c.author || 'Robin',
      body: c.quote ? `> ${c.quote.split('\n').join('\n> ')}\n\n${c.text}` : c.text,
      createdAt: c.createdAt,
      url: obsidianUrl(path.join(this.studio, 'Comments', `${c.id}.md`)),
    }));
  }

  /** Runs Studio's own start script, which does nothing when Studio is already up. */
  private ensure(): Promise<void> {
    const cmd = this.server.ensure;
    if (!cmd?.length) return Promise.resolve();
    return new Promise((resolve, reject) =>
      execFile(cmd[0], cmd.slice(1), { timeout: 30_000 }, (err, _out, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve())),
    );
  }

  /** Asks the Studio app, starting it first if nothing answers. Studio only takes requests from its own origin. */
  private async studioApi(p: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}, started = false): Promise<any> {
    const origin = new URL(this.server.url).origin;
    let res: Response;
    try {
      res = await fetch(`${origin}${p}`, { ...init, headers: { origin, ...init.headers } });
    } catch (err) {
      if (started || !this.server.ensure?.length) throw new Error(`Vaelmoor Studio isn't answering at ${origin}. Start it from the Vaelmoor Studio launcher.`);
      await this.ensure();
      return this.studioApi(p, init, true);
    }
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message ?? data.error ?? `Studio answered ${res.status}`);
    return data;
  }

  private labelsOf(t: StudioTask): GhLabel[] {
    const out = [STAGE_LABELS[t.reported.stage]];
    const project = this.projects.get(t.projectId);
    if (project) out.push({ name: project, color: '#57606a' });
    if (t.reported.verdict === 'changes_requested') out.push({ name: '🛠 changes requested', color: '#cf222e' });
    return out;
  }

  private issueCards(): GhIssue[] {
    return this.tasks.map(({ task: t, file, number, updatedAt }) => {
      const r = t.reported;
      // Working, verifying and awaiting Robin all sit in In progress; who has it is the card's assignee.
      const assignees = r.stage === 'awaiting_robin' ? ['Robin'] : r.stage === 'working' || r.stage === 'verifying' ? [r.owner ?? 'agent'] : [];
      return {
        number,
        title: t.title,
        state: r.stage === 'done' ? 'CLOSED' : 'OPEN',
        url: obsidianUrl(file),
        author: r.owner ?? 'studio',
        labels: this.labelsOf(t),
        assignees,
        createdAt: updatedAt,
        updatedAt,
        body: taskBody(t, file).slice(0, 4000),
        comments: this.comments.get(path.relative(this.vault, file))?.length ?? 0,
      };
    });
  }

  private pullCards(): GhPull[] {
    return this.tasks
      .filter(({ task: t }) => ['verifying', 'awaiting_robin', 'done'].includes(t.reported.stage) || t.reported.verdict === 'accepted')
      .map(({ task: t, file, number, updatedAt }) => ({
        number,
        title: t.title,
        ...pullState(t.reported),
        url: obsidianUrl(file),
        author: t.reported.owner ?? 'studio',
        labels: this.labelsOf(t),
        // Never a real branch, so no worker is ever matched to (or sent home for) a Studio card.
        headRefName: `studio/${t.id}`,
        baseRefName: 'studio',
        createdAt: updatedAt,
        updatedAt,
        additions: 0,
        deletions: 0,
        checks: t.reported.built && t.reported.tested ? 'pass' : t.reported.built ? 'pending' : 'none',
        body: taskBody(t, file).slice(0, 4000),
        closes: [number],
      }));
  }

  private find(n: number): Loaded {
    const found = this.tasks.find((t) => t.number === n);
    if (!found) throw new Error(`No Studio task #${n}`);
    return found;
  }

  async repoInfo(): Promise<GhRepoInfo> {
    return { nameWithOwner: 'Vaelmoor Studio', methods: ['squash'] };
  }

  async viewer(): Promise<string> {
    return 'Robin';
  }

  async issueDetail(n: number): Promise<GhIssueDetail> {
    const { task, file } = this.find(n);
    return { number: n, state: task.reported.stage === 'done' ? 'CLOSED' : 'OPEN', body: taskBody(task, file), comments: this.commentsOn(file), viewer: 'Robin' };
  }

  async pullDetail(n: number): Promise<GhPullDetail> {
    const { task, file } = this.find(n);
    const s = pullState(task.reported);
    return {
      number: n,
      body: taskBody(task, file),
      state: s.state,
      isDraft: s.isDraft,
      reviewDecision: s.reviewDecision,
      headRefName: `studio/${task.id}`,
      baseRefName: 'studio',
      mergeable: 'UNKNOWN',
      mergeStateStatus: 'BLOCKED',
      commits: 0,
      comments: this.commentsOn(file),
      reviews: [],
      reviewComments: [],
      checks: [
        { name: 'Built', state: task.reported.built ? 'pass' : 'pending' },
        { name: 'Tested', state: task.reported.tested ? 'pass' : 'pending' },
        { name: "Robin's verdict", state: task.reported.verdict === 'accepted' || task.reported.verdict === 'not_required' ? 'pass' : task.reported.verdict === 'changes_requested' ? 'fail' : 'pending' },
      ],
      repo: await this.repoInfo(),
      viewer: 'Robin',
    };
  }

  async pullDiff(): Promise<string> {
    return '';
  }

  /**
   * Saves a comment on the task's note through the Studio app, exactly as Studio's own comment box
   * does: Studio checks the note hasn't changed, writes the file and signs it as Robin.
   */
  async comment(_kind: 'issue' | 'pull', n: number, body: string, _as?: GhAs): Promise<{ comment?: GhComment; error?: string }> {
    try {
      const { file } = this.find(n);
      const rel = path.relative(this.vault, file);
      const snapshot = await this.studioApi('/api/snapshot');
      const note = (snapshot.notes ?? []).find((x: any) => x.path === rel);
      if (!note) throw new Error(`Studio hasn't indexed ${rel} yet. Try again in a few seconds.`);
      const key = `note:${note.id}`;
      const [target, session] = await Promise.all([this.studioApi(`/api/targets/${encodeURIComponent(key)}`), this.studioApi('/api/comments')]);
      const saved = await this.studioApi('/api/comments', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-studio-token': String(session.token) },
        body: JSON.stringify({ id: randomUUID(), target: key, sourceHash: target.sourceHash, text: body, quote: '' }),
      });
      this.readComments();
      void this.refresh();
      return { comment: { id: saved.id, author: saved.author ?? 'Robin', body: saved.text, createdAt: saved.createdAt, url: obsidianUrl(path.join(this.vault, saved.path)) } };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  async review(): Promise<string> {
    throw new Error(READ_ONLY);
  }

  async merge(_n: number, _method: GhMergeMethod, _deleteBranch: boolean, _auto: boolean, _as?: GhAs): Promise<string | undefined> {
    return READ_ONLY;
  }

  async close(_kind: 'issue' | 'pull', _n: number, _opts: { comment?: string; reason?: GhCloseReason; deleteBranch?: boolean }, _as?: GhAs): Promise<string | undefined> {
    return READ_ONLY;
  }

  async repoLabels(): Promise<GhLabel[]> {
    return Object.values(STAGE_LABELS);
  }

  async setLabels(): Promise<{ labels?: GhLabel[]; error?: string }> {
    return { error: READ_ONLY };
  }

  /** A worker took the task: In progress on the board until the office restarts or Studio says otherwise. */
  async claim(issue: number): Promise<string | undefined> {
    this.claims.take(issue)(true, Infinity);
    this.issues = { ...this.issues, items: this.claims.mark(this.issues.items) };
    this.onIssues(this.issues);
    return undefined;
  }
}
