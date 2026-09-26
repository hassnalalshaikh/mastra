/**
 * Fits an accessibility snapshot into a character budget without hiding the
 * elements the agent acts on. A long page (an article with 1,500 links) keeps
 * the elements matching `find` first, then every form control, then the rest
 * in page order; what was left out is counted so the agent can bring it into
 * view with `find` or ask for everything with `showAll`.
 */

/** Roles an agent types into, clicks to submit, or chooses with. */
const CONTROL_ROLE =
  /^\s*- (textbox|searchbox|combobox|button|checkbox|radio|switch|slider|spinbutton|listbox|option|menuitem|menuitemcheckbox|menuitemradio|tab|treeitem)\b/;
const ROLE = /^\s*- ([a-z]+)/;

export interface SnapshotBudgetOptions {
  /** Largest snapshot text in characters. Undefined or non-positive: no limit. */
  maxChars?: number;
  /** Words (case-insensitive) whose element lines are always kept and listed in `matches`. */
  find?: string;
  /** Return the whole snapshot regardless of the limit. */
  showAll?: boolean;
}

export interface SnapshotBudgetResult {
  /** The page in page order: the whole page, or the lines that fit the limit. */
  snapshot: string;
  /** Element lines containing the `find` words (also inside `snapshot`); undefined without `find`. */
  matches?: string[];
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
  const lines = tree.split('\n');
  const words = options.find?.trim().toLowerCase();
  const isMatch = (line: string) => Boolean(words) && ROLE.test(line) && line.toLowerCase().includes(words!);
  const matches = words ? lines.filter(isMatch).map(line => line.trim()) : undefined;
  const maxChars = options.maxChars;
  if (options.showAll || !maxChars || maxChars <= 0 || tree.length <= maxChars) {
    return { snapshot: tree, matches };
  }

  // Matches first, then controls, then everything else in page order, until the budget is spent.
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
    if (isMatch(line)) take(index);
  });
  lines.forEach((line, index) => {
    if (!keep[index] && CONTROL_ROLE.test(line)) take(index);
  });
  for (let index = 0; index < lines.length; index++) {
    if (!keep[index] && !take(index)) break;
  }
  const left = lines.filter((_, index) => !keep[index]);
  return {
    snapshot: lines.filter((_, index) => keep[index]).join('\n'),
    matches,
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
    'Every form control is listed. To bring others into view, call browser_snapshot with find:"<words from the element>" ' +
    '(matching elements are always kept and listed in matches), or showAll:true for the whole page.'
  );
}
