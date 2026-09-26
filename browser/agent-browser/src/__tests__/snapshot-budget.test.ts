import { describe, expect, it } from 'vitest';
import { describeOmittedElements, fitSnapshotToBudget } from '../snapshot-budget';

const article = [
  '- link "Jump to content" @e1',
  '- button "Main menu" @e2',
  '- searchbox "Search Wikipedia" @e3',
  ...Array.from({ length: 200 }, (_, i) => `- link "Article link number ${i}" @e${i + 4}`),
  '- button "Toggle the table of contents" @e204',
  '- link "Powered by MediaWiki" @e205',
].join('\n');

describe('fitSnapshotToBudget', () => {
  it('returns a short page unchanged', () => {
    const tree = '- link "Home" @e1\n- button "Go" @e2';
    expect(fitSnapshotToBudget(tree, { maxChars: 1000 })).toEqual({ snapshot: tree, matched: undefined });
  });

  it('keeps every control of a long page, fills the rest in page order and counts what was left out', () => {
    const result = fitSnapshotToBudget(article, { maxChars: 1200 });
    expect(result.snapshot.length).toBeLessThanOrEqual(1200);
    const lines = result.snapshot.split('\n');
    expect(lines).toContain('- button "Main menu" @e2');
    expect(lines).toContain('- searchbox "Search Wikipedia" @e3');
    // A control at the very end of the page is still listed.
    expect(lines).toContain('- button "Toggle the table of contents" @e204');
    // Page order is kept.
    expect(lines[0]).toBe('- link "Jump to content" @e1');
    expect(lines.indexOf('- searchbox "Search Wikipedia" @e3')).toBeLessThan(
      lines.indexOf('- button "Toggle the table of contents" @e204'),
    );
    expect(result.omitted?.total).toBe(205 - lines.length);
    expect(result.omitted?.byRole).toEqual({ link: 205 - lines.length });
  });

  it('lists matching elements with find, whatever the limit', () => {
    const result = fitSnapshotToBudget(article, { maxChars: 1200, find: 'number 150' });
    expect(result.snapshot).toBe('- link "Article link number 150" @e154');
    expect(result.matched).toBe(1);
    expect(result.omitted).toBeUndefined();
    expect(fitSnapshotToBudget(article, { find: 'nothing like this' })).toEqual({ snapshot: '', matched: 0 });
  });

  it('returns the whole page with showAll or without a limit', () => {
    expect(fitSnapshotToBudget(article, { maxChars: 1200, showAll: true }).snapshot).toBe(article);
    expect(fitSnapshotToBudget(article, {}).snapshot).toBe(article);
    expect(fitSnapshotToBudget(article, { maxChars: 0 }).snapshot).toBe(article);
  });

  it('shortens the controls too when they alone exceed the limit', () => {
    const buttons = Array.from({ length: 50 }, (_, i) => `- button "Button ${i}" @e${i + 1}`).join('\n');
    const result = fitSnapshotToBudget(buttons, { maxChars: 200 });
    expect(result.snapshot.length).toBeLessThanOrEqual(200);
    expect(result.omitted?.byRole.button).toBe(50 - result.snapshot.split('\n').length);
  });

  it('tells the agent what was left out and how to see it', () => {
    expect(describeOmittedElements({ total: 1377, byRole: { link: 1376, button: 1 } })).toBe(
      'Long page: 1377 more elements not shown (1376 links, 1 button). Every form control is listed. ' +
        'To see the others, call browser_snapshot with find:"<words from the element>" to list matching elements, ' +
        'or showAll:true for the whole page.',
    );
  });
});
