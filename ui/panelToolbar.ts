/// <reference types="blockbench-types" />
/**
 * Native toolbar for the MCP panel.
 *
 * Bar items are registered Blockbench `BarItem`s so they get keybinds, menu
 * presence, and the host's toggle styling for free. The toolbar node is moved
 * into the panel template's `toolbar_wrapper` by Blockbench after mount.
 *
 * Teardown is deliberately careful: `BarItem.delete()` removes the item from
 * every toolbar it sits in, and `Toolbar.remove()` saves the surviving layout
 * to `localStorage`, which would persist an empty toolbar and hide both items
 * after the next reload. Items are detached from the toolbar first and the
 * stored layout keys are cleared.
 *
 * @module
 */

/** Toolbar ID referenced by the panel template's `toolbar_wrapper`. */
export const PANEL_TOOLBAR_ID = "mcp_panel_toolbar";
/** Toggle that includes experimental tools and prompts in the panel lists. */
export const SHOW_EXPERIMENTAL_ID = "mcp_show_experimental";
/** Badge shown while the active project carries the AI usage disclosure stamp. */
export const AI_USED_BADGE_ID = "mcp_ai_used";

interface IPanelToolbarHandles {
  toolbar: Toolbar;
  toggle: Toggle;
  badge: BarText;
}

/** Host toolbar persistence, keyed by toolbar ID plus the `_known` item registry. */
interface IStoredToolbars {
  _known?: string[];
  [toolbarId: string]: unknown;
}

let handles: IPanelToolbarHandles | undefined;

/** Whether the active project was stamped by AI usage disclosure. */
export function activeProjectUsedAi(): boolean {
  if (typeof Project === "undefined" || !Project) return false;
  return (Project as unknown as { ai_used?: boolean }).ai_used === true;
}

/** Current value of the experimental toggle; `true` before the toolbar exists. */
export function isShowExperimentalEnabled(): boolean {
  return handles?.toggle.value !== false;
}

/** Opens the native Project settings dialog, where the disclosure fields are shown. */
function openProjectSettings(): void {
  (BarItems.project_window as Action | undefined)?.trigger();
}

/** `BarText` renders a bare div: give the badge a tooltip and keyboard access. */
function makeBadgeAccessible(badge: BarText): void {
  const node = badge.node;
  if (!node) return;
  node.title = tl("mcp.toolbar.ai_used_desc");
  node.setAttribute("role", "button");
  node.setAttribute("tabindex", "0");
  node.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openProjectSettings();
  });
}

/**
 * Registers the toolbar and its items once.
 *
 * @param onExperimentalChange - Receives the toggle value so the panel can filter its lists.
 * @returns The toolbar to pass in the panel's `toolbars` option.
 */
export function panelToolbarSetup(onExperimentalChange: (value: boolean) => void): Toolbar {
  if (handles) return handles.toolbar;

  // blockbench-types omits `save_on_restart`; the host persists the toggle value in localStorage with it.
  const toggle = new Toggle(SHOW_EXPERIMENTAL_ID, {
    name: tl("mcp.toolbar.show_experimental"),
    description: tl("mcp.toolbar.show_experimental_desc"),
    icon: "science",
    category: "view",
    default: true,
    save_on_restart: true,
    onChange: (value: boolean) => onExperimentalChange(value),
  } as ConstructorParameters<typeof Toggle>[1]);

  // blockbench-types marks `onUpdate` as required, but the host only calls it when it is a function.
  const badgeOptions: Omit<ConstructorParameters<typeof BarText>[1], "onUpdate"> = {
    name: tl("mcp.toolbar.ai_used"),
    description: tl("mcp.toolbar.ai_used_desc"),
    text: tl("mcp.toolbar.ai_used"),
    condition: activeProjectUsedAi,
    click: openProjectSettings,
  };
  const badge = new BarText(AI_USED_BADGE_ID, badgeOptions as ConstructorParameters<typeof BarText>[1]);
  makeBadgeAccessible(badge);

  const toolbar = new Toolbar(PANEL_TOOLBAR_ID, {
    id: PANEL_TOOLBAR_ID,
    name: "MCP",
    children: [SHOW_EXPERIMENTAL_ID, "+", AI_USED_BADGE_ID],
  });

  handles = { toolbar, toggle, badge };
  return toolbar;
}

/** Re-evaluates item conditions, showing or hiding the AI badge for the active project. */
export function refreshPanelToolbar(): void {
  handles?.toolbar.update();
}

/** Forgets the persisted layout so a reload rebuilds the toolbar from its defaults. */
function clearStoredLayout(): void {
  if (typeof BARS === "undefined") return;
  const stored = (BARS as unknown as { stored?: IStoredToolbars }).stored;
  if (!stored) return;
  delete stored[PANEL_TOOLBAR_ID];
  stored._known = stored._known?.filter(id => id !== SHOW_EXPERIMENTAL_ID && id !== AI_USED_BADGE_ID);
}

/** Deletes the toolbar and its items without persisting a stripped layout. */
export function panelToolbarTeardown(): void {
  if (!handles) return;
  const { toolbar, toggle, badge } = handles;
  // Detach first: BarItem.delete() -> Toolbar.remove() -> Toolbar.save() would persist the empty bar.
  [toggle, badge].forEach(item => {
    (item as unknown as { toolbars: Toolbar[] }).toolbars.length = 0;
  });
  badge.delete();
  toggle.delete();
  toolbar.node?.remove();
  clearStoredLayout();
  // The host registers toolbars in `Toolbars` but offers no delete(); unregister by hand.
  delete (Toolbars as Record<string, Toolbar>)[PANEL_TOOLBAR_ID];
  handles = undefined;
}
