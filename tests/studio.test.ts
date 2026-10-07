import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StudioBoards, frontmatter } from '../src/server/studio.js';
import type { GhIssue, GhPull, GhState } from '../src/shared/protocol.js';

const note = (record: object) => `---\n${JSON.stringify(record, null, 2)}\n---\n\n# Note\n`;
const task = (id: string, stage: string, verdict = 'pending') => ({
  type: 'task', id, title: `Task ${id}`, projectId: 'p1', criteria: [{ id: 'c', text: 'It works', requiresRobin: true }],
  reported: { stage, label: stage, summary: 's', asOf: '2026-10-01', built: stage !== 'planned', tested: false, verdict },
});

function studio(tasks: object[]) {
  const root = mkdtempSync(path.join(tmpdir(), 'studio-'));
  mkdirSync(path.join(root, 'Tasks'));
  mkdirSync(path.join(root, 'Projects'));
  writeFileSync(path.join(root, 'Projects', 'p1.md'), note({ type: 'project', id: 'p1', title: 'World' }));
  tasks.forEach((t: any) => writeFileSync(path.join(root, 'Tasks', `${t.id}.md`), note(t)));
  writeFileSync(path.join(root, 'Tasks', 'broken.md'), '---\n{ nope\n---\n');
  const data = mkdtempSync(path.join(tmpdir(), 'studio-data-'));
  let issues!: GhState<GhIssue>, pulls!: GhState<GhPull>;
  const boards = new StudioBoards(root, data, (s) => (issues = s), (s) => (pulls = s));
  return { root, data, boards, get: () => ({ issues: issues.items, pulls: pulls.items }) };
}

test('frontmatter reads the JSON record between the --- lines', () => {
  assert.deepEqual(frontmatter('---\n{"a": 1}\n---\n# x'), { a: 1 });
  assert.throws(() => frontmatter('# no frontmatter'));
});

test('every task is an issue card, and only built ones are on the review board', async () => {
  const s = studio([task('a', 'planned'), task('b', 'working'), task('c', 'awaiting_robin'), task('d', 'done', 'accepted'), task('e', 'awaiting_robin', 'changes_requested')]);
  await s.boards.refresh();
  const { issues, pulls } = s.get();
  assert.deepEqual(issues.map((i) => i.title), ['Task a', 'Task b', 'Task c', 'Task d', 'Task e'], 'the broken note is skipped');
  assert.equal(issues.find((i) => i.title === 'Task a')!.assignees.length, 0, 'planned is Open');
  assert.ok(issues.find((i) => i.title === 'Task b')!.assignees.length > 0, 'working is In progress');
  assert.equal(issues.find((i) => i.title === 'Task d')!.state, 'CLOSED');
  assert.ok(issues[0].labels.some((l) => l.name === 'World'), 'the project is a label');
  assert.ok(issues[0].url.startsWith('obsidian://open?path='));
  const byTitle = (t: string) => pulls.find((p) => p.title === t)!;
  assert.equal(pulls.length, 3);
  assert.equal(byTitle('Task c').reviewDecision, '');
  assert.equal(byTitle('Task d').state, 'MERGED');
  assert.equal(byTitle('Task e').reviewDecision, 'CHANGES_REQUESTED');
});

test('a task keeps its card number when tasks are added', async () => {
  const s = studio([task('b', 'ready'), task('c', 'ready')]);
  await s.boards.refresh();
  const before = Object.fromEntries(s.get().issues.map((i) => [i.title, i.number]));
  writeFileSync(path.join(s.root, 'Tasks', 'a.md'), note(task('a', 'ready')));
  const again = new StudioBoards(s.root, s.data, () => {}, () => {});
  await again.refresh();
  const after = Object.fromEntries(again.issues.items.map((i) => [i.title, i.number]));
  assert.equal(after['Task b'], before['Task b']);
  assert.equal(after['Task c'], before['Task c']);
  assert.equal(after['Task a'], 3);
});

test("the board's GitHub actions leave Studio alone", async () => {
  const s = studio([task('a', 'awaiting_robin')]);
  await s.boards.refresh();
  assert.match((await s.boards.merge(1, 'squash', false, false)) ?? '', /read-only/);
  assert.match((await s.boards.comment('issue', 1, 'hi')).error ?? '', /read-only/);
  assert.equal(await s.boards.claim(1), undefined);
  assert.ok(s.get().issues[0].taken);
});
