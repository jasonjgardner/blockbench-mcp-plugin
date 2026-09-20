import { describe, expect, test } from "bun:test";
import {
  AI_USED_BADGE_ID,
  PANEL_TOOLBAR_ID,
  SHOW_EXPERIMENTAL_ID,
  activeProjectUsedAi,
  isShowExperimentalEnabled,
  panelToolbarSetup,
  panelToolbarTeardown,
  refreshPanelToolbar,
} from "@/ui/panelToolbar";
import { useGlobals } from "@/tests/helpers/globals";

/** Minimal element double for the badge node: attributes, title, and listeners. */
class HostNode {
  title = "";
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, (event: unknown) => void>();
  removed = false;

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, listener);
  }

  remove(): void {
    this.removed = true;
  }
}

interface IItemOptions {
  condition?: () => boolean;
  onChange?: (value: boolean) => void;
  click?: () => void;
  default?: boolean;
}

/** Mirrors the host contract that matters here: `delete()` asks each containing toolbar to remove and save. */
class HostBarItem {
  static deleted: string[] = [];
  readonly id: string;
  readonly options: IItemOptions;
  readonly node = new HostNode();
  toolbars: HostToolbar[] = [];
  value: boolean;

  constructor(id: string, options: IItemOptions) {
    this.id = id;
    this.options = options;
    this.value = options.default ?? false;
  }

  delete(): void {
    this.toolbars.forEach(toolbar => toolbar.remove(this));
    HostBarItem.deleted.push(this.id);
  }
}

class HostToolbar {
  static saves = 0;
  readonly id: string;
  readonly children: string[];
  readonly node = new HostNode();
  updates = 0;

  constructor(id: string, options: { children: string[] }) {
    this.id = id;
    this.children = options.children;
    Toolbars[id] = this as unknown as Toolbar;
    // Mirror Toolbar.build(): items are attached to the toolbar and recorded as known.
    options.children.forEach(childId => {
      const item = BarItems[childId] as unknown as HostBarItem | undefined;
      if (item) item.toolbars.push(this);
    });
    stored[id] = [...options.children];
    stored._known = [...(stored._known ?? []), ...options.children];
  }

  remove(item: HostBarItem): void {
    HostToolbar.saves += 1;
    stored[this.id] = this.children.filter(id => id !== item.id);
  }

  update(): void {
    this.updates += 1;
  }
}

const stored: { _known?: string[]; [id: string]: unknown } = {};
let triggered = 0;

useGlobals(() => {
  HostBarItem.deleted = [];
  HostToolbar.saves = 0;
  triggered = 0;
  Object.keys(stored).forEach(key => delete stored[key]);
  const items: Record<string, HostBarItem> = {};
  return {
    Toggle: class extends HostBarItem {
      constructor(id: string, options: IItemOptions) {
        super(id, options);
        items[id] = this;
      }
    },
    BarText: class extends HostBarItem {
      constructor(id: string, options: IItemOptions) {
        super(id, options);
        items[id] = this;
      }
    },
    Toolbar: HostToolbar,
    Toolbars: {},
    BarItems: Object.assign(items, { project_window: { trigger: () => { triggered += 1; } } }),
    BARS: { stored },
    Project: { uuid: "project" },
    tl: (key: string) => key,
  };
});

describe("badge condition", () => {
  test("is true only for a stamped active project", () => {
    expect(activeProjectUsedAi()).toBe(false);
    Object.assign(globalThis, { Project: { uuid: "project", ai_used: true } });
    expect(activeProjectUsedAi()).toBe(true);
    Object.assign(globalThis, { Project: null });
    expect(activeProjectUsedAi()).toBe(false);
  });
});

describe("toolbar lifecycle", () => {
  test("registers the toggle, the badge, and the toolbar once", () => {
    const changes: boolean[] = [];
    const toolbar = panelToolbarSetup(value => changes.push(value));
    expect(panelToolbarSetup(() => {})).toBe(toolbar);
    expect(Toolbars[PANEL_TOOLBAR_ID]).toBe(toolbar);
    expect((toolbar as unknown as HostToolbar).children).toEqual([SHOW_EXPERIMENTAL_ID, "+", AI_USED_BADGE_ID]);

    const toggle = BarItems[SHOW_EXPERIMENTAL_ID] as unknown as HostBarItem;
    toggle.options.onChange?.(false);
    expect(changes).toEqual([false]);
    expect(isShowExperimentalEnabled()).toBe(true);
    toggle.value = false;
    expect(isShowExperimentalEnabled()).toBe(false);

    const badge = BarItems[AI_USED_BADGE_ID] as unknown as HostBarItem;
    expect(badge.options.condition).toBe(activeProjectUsedAi);
    expect(badge.node.attributes.get("role")).toBe("button");
    expect(badge.node.attributes.get("tabindex")).toBe("0");
    expect(badge.node.title).toBe("mcp.toolbar.ai_used_desc");

    badge.options.click?.();
    badge.node.listeners.get("keydown")?.({ key: "Enter", preventDefault: () => {} });
    badge.node.listeners.get("keydown")?.({ key: "x", preventDefault: () => {} });
    expect(triggered).toBe(2);

    refreshPanelToolbar();
    expect((toolbar as unknown as HostToolbar).updates).toBe(1);
    panelToolbarTeardown();
  });

  test("teardown never lets the host persist a stripped layout and clears stored keys", () => {
    panelToolbarSetup(() => {});
    expect(stored[PANEL_TOOLBAR_ID]).toBeDefined();
    expect(stored._known).toEqual([SHOW_EXPERIMENTAL_ID, "+", AI_USED_BADGE_ID]);

    panelToolbarTeardown();
    expect(HostToolbar.saves).toBe(0);
    expect(HostBarItem.deleted.toSorted()).toEqual([AI_USED_BADGE_ID, SHOW_EXPERIMENTAL_ID]);
    expect(stored[PANEL_TOOLBAR_ID]).toBeUndefined();
    expect(stored._known).toEqual(["+"]);
    expect(Toolbars[PANEL_TOOLBAR_ID]).toBeUndefined();

    panelToolbarTeardown();
    expect(HostBarItem.deleted).toHaveLength(2);
    expect(isShowExperimentalEnabled()).toBe(true);
  });
});
