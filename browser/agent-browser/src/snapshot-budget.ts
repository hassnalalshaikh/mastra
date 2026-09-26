/**
 * Fits an accessibility snapshot into a character budget without hiding the
 * controls the agent acts on. Long pages (an article with 1,500 links) keep
 * every form control, then fill the rest in page order; what was left out is
 * counted so the agent can ask for it with `find` or `showAll`.
 */

/** Roles an agent types into, clicks to submit, or chooses with. Always kept first. */
const CONTROL_ROLE =
  /^\s*- (textbox|searchbox|combobox|button|checkbox|radio|switch|slider|spinbutton|listbox|option|menuitem|menuitemcheckbox|menuitemradio|tab|treeitem)\b/;
const ROLE = /^\s*- ([a-z]+)/;

export interface SnapshotBudgetOptions {
  /** Largest snapshot text in characters. Undefined or non-positive: no limit. */
  maxChars?: number;
  /** Keep only element lines containing these words (case-insensitive). */
  find?: string;
  /** Return the whole snapshot regardless of the limit. */
  showAll?: boolean;
}

export interface SnapshotBudgetResult {
  snapshot: string;
  /** Element lines matching `find`, or undefined when no `find` was given. */
  matched?: number;
  /** Element lines left out by the limit, by role (e.g. { link: 1376 }). Undefined when nothing was left out. */
  omitted?: { total: number; byRole: Record<string, number> };
}

const countRoles = (lines: readonly string[]): Record<string, number> => {
  const byRole: Record<string, number> = {};
  for (const line of lines) {
    const role = ROLE.exec(line)?.[1] ?? 'other';
    byRole[role] = (byRole[role] ?? 0) + 1;
  }
  return byRole;
};

export function fitSnapshotToBudget(tree: string, options: SnapshotBudgetOptions = {}): SnapshotBudgetResult {
  let lines = tree.split('\n');
  let matched: number | undefined;
  const words = options.find?.trim().toLowerCase();
  if (words) {
    lines = lines.filter(line => line.toLowerCase().includes(words));
    matched = lines.length;
  }
  const text = lines.join('\n');
  const maxChars = options.maxChars;
  if (options.showAll || !maxChars || maxChars <= 0 || text.length <= maxChars) {
    return { snapshot: text, matched };
  }

  // Controls first (in page order), then everything else in page order, until the budget is spent.
  const keep = new Array<boolean>(lines.length).fill(false);
  let used = 0;
  const take = (index: number) => {
    const cost = lines[index]!.length + 1;
    if (used + cost > maxChars) return false;
    keep[index] = true;
    used += cost;
    return true;
  };
  lines.forEach((line, index) => {
    if (CONTROL_ROLE.test(line)) take(index);
  });
  for (let index = 0; index < lines.length; index++) {
    if (!keep[index] && !take(index)) break;
  }
  const left = lines.filter((_, index) => !keep[index]);
  return {
    snapshot: lines.filter((_, index) => keep[index]).join('\n'),
    matched,
    omitted: { total: left.length, byRole: countRoles(left) },
  };
}

/** A plain sentence telling the agent what was left out and how to see it. */
export function describeOmittedElements(omitted: NonNullable<SnapshotBudgetResult['omitted']>): string {
  const parts = Object.entries(omitted.byRole)
    .sort((a, b) => b[1] - a[1])
    .map(([role, count]) => `${count} ${role}${count === 1 ? '' : 's'}`);
  return (
    `Long page: ${omitted.total} more elements not shown (${parts.join(', ')}). ` +
    'Every form control is listed. To see the others, call browser_snapshot with find:"<words from the element>" ' +
    'to list matching elements, or showAll:true for the whole page.'
  );
}
