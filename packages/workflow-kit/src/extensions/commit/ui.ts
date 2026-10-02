/**
 * ui.ts — interactive dialogs of the /commit command.
 *
 * Uses only pi's own APIs: ExtensionUIContext, ctx.ui.custom and pi-tui
 * (Input, fuzzyFilter, SelectList). Kept separate from core.ts (pi-free
 * logic) and index.ts (command flow).
 */

import {
  DynamicBorder,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  Input,
  SelectList,
  type SelectListTheme,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { orderModelOptions } from "./core.ts";

const MAX_MESSAGE_LINES = 15;
const MAX_VISIBLE = 10;
const ACTIONS = ["提交", "重新生成", "取消"] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * Pick the generation model — searchable fuzzy picker in TUI (type to
 * filter via pi-tui's fuzzyFilter), plain select elsewhere. `first` leads
 * the list; when `prependIfMissing`, an absent `first` is added at the top
 * (used for the remembered last model, which must always lead).
 */
export async function chooseModel(
  ctx: ExtensionCommandContext,
  first?: string,
  prependIfMissing = false,
): Promise<string | undefined> {
  const registry = ctx.modelRegistry;
  const labels = (registry.getAvailable?.() ?? registry.getAll()).map(
    (m) => `${m.provider}/${m.id}`,
  );
  const options = orderModelOptions(labels, first, prependIfMissing);
  if (options.length === 0) {
    ctx.ui.notify("没有可用的模型", "warning");
    return undefined;
  }
  if (ctx.mode === "tui") {
    return searchableSelect(ctx, "选择 commit 生成模型", options);
  }
  return ctx.ui.select("选择 commit 生成模型", options);
}

/**
 * Type-to-fuzzy-filter model picker hosted in a ctx.ui.custom dialog.
 * Mirrors pi's own /model UX; filtering is pi-tui's fuzzyFilter.
 */
async function searchableSelect(
  ctx: ExtensionCommandContext,
  title: string,
  options: string[],
): Promise<string | undefined> {
  const result = await ctx.ui.custom<string | undefined>(
    (tui, theme, keybindings, done) => {
      const root = new Container();
      const searchInput = new Input();
      const listContainer = new Container();
      let filtered = options.slice();
      let selectedIndex = 0;
      let focused = false;

      const accent = (t: string) => theme.fg("accent", t);
      const muted = (t: string) => theme.fg("muted", t);
      const dim = (t: string) => theme.fg("dim", t);
      const text = (t: string) => theme.fg("text", t);

      function updateList() {
        listContainer.clear();
        if (filtered.length === 0) {
          listContainer.addChild(new Text(muted("  无匹配模型"), 1, 0));
          return;
        }
        const start = Math.max(
          0,
          Math.min(
            selectedIndex - Math.floor(MAX_VISIBLE / 2),
            filtered.length - MAX_VISIBLE,
          ),
        );
        const end = Math.min(start + MAX_VISIBLE, filtered.length);
        for (const [offset, item] of filtered.slice(start, end).entries()) {
          const i = start + offset;
          const line =
            i === selectedIndex ? accent(`→ ${item}`) : `  ${text(item)}`;
          listContainer.addChild(new Text(line, 1, 0));
        }
        if (start > 0 || end < filtered.length) {
          listContainer.addChild(
            new Text(
              muted(`  (${selectedIndex + 1}/${filtered.length})`),
              1,
              0,
            ),
          );
        }
      }

      function applyFilter() {
        filtered = fuzzyFilter(options, searchInput.getValue(), (s) => s);
        selectedIndex = Math.min(
          selectedIndex,
          Math.max(0, filtered.length - 1),
        );
        updateList();
      }

      function pick() {
        const chosen = filtered[selectedIndex];
        if (chosen !== undefined) done(chosen);
      }

      searchInput.onSubmit = () => pick();

      root.addChild(new DynamicBorder((s) => accent(s)));
      root.addChild(new Spacer(1));
      root.addChild(new Text(accent(theme.bold(title)), 1, 0));
      root.addChild(new Spacer(1));
      root.addChild(searchInput);
      root.addChild(new Spacer(1));
      root.addChild(listContainer);
      root.addChild(new Spacer(1));
      root.addChild(
        new Text(dim("输入过滤 • ↑↓ 选择 • 回车确认 • Esc 取消"), 1, 0),
      );
      root.addChild(new Spacer(1));
      root.addChild(new DynamicBorder((s) => accent(s)));

      updateList();

      return {
        get focused() {
          return focused;
        },
        set focused(value: boolean) {
          focused = value;
          searchInput.focused = value;
        },
        render: (w: number) => root.render(w),
        invalidate: () => root.invalidate(),
        handleInput: (data: string) => {
          if (keybindings.matches(data, "tui.select.up")) {
            if (filtered.length === 0) return;
            selectedIndex =
              selectedIndex === 0 ? filtered.length - 1 : selectedIndex - 1;
            updateList();
            tui.requestRender();
            return;
          }
          if (keybindings.matches(data, "tui.select.down")) {
            if (filtered.length === 0) return;
            selectedIndex =
              selectedIndex === filtered.length - 1 ? 0 : selectedIndex + 1;
            updateList();
            tui.requestRender();
            return;
          }
          if (keybindings.matches(data, "tui.select.confirm")) {
            pick();
            return;
          }
          if (keybindings.matches(data, "tui.select.cancel")) {
            done(undefined);
            return;
          }
          searchInput.handleInput(data);
          applyFilter();
          tui.requestRender();
        },
      };
    },
  );

  return result ?? undefined;
}

/** Confirm the generated message: 提交 / 重新生成 / 取消. */
export async function chooseAction(
  ctx: ExtensionCommandContext,
  message: string,
): Promise<Action | undefined> {
  if (ctx.mode === "tui") {
    return ctx.ui.custom<Action | undefined>(
      (_tui, theme, _keybindings, done) => {
        const root = new Container();
        const listTheme: SelectListTheme = {
          selectedPrefix: (t) => theme.fg("accent", t),
          selectedText: (t) => theme.fg("accent", t),
          description: (t) => theme.fg("muted", t),
          scrollInfo: (t) => theme.fg("dim", t),
          noMatch: (t) => theme.fg("dim", t),
        };

        root.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
        root.addChild(new Spacer(1));
        root.addChild(
          new Text(
            theme.bold(theme.fg("accent", "生成的 commit message")),
            1,
            0,
          ),
        );
        root.addChild(new Spacer(1));

        const lines = message.split("\n");
        for (const line of lines.slice(0, MAX_MESSAGE_LINES)) {
          root.addChild(new Text(theme.fg("text", line), 1, 0));
        }
        if (lines.length > MAX_MESSAGE_LINES) {
          root.addChild(
            new Text(
              theme.fg("dim", `… 共 ${lines.length} 行,其余已省略`),
              1,
              0,
            ),
          );
        }

        root.addChild(new Spacer(1));
        const list = new SelectList(
          ACTIONS.map((action) => ({ value: action, label: action })),
          ACTIONS.length,
          listTheme,
        );
        list.onSelect = (item) => done(item.value as Action);
        list.onCancel = () => done(undefined);
        root.addChild(list);
        root.addChild(new Spacer(1));
        root.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

        return {
          render: (width: number) => root.render(width),
          invalidate: () => root.invalidate(),
          handleInput: (data: string) => list.handleInput(data),
        };
      },
    );
  }

  // RPC: custom() is TUI-only, fall back to plain select.
  return (await ctx.ui.select(`Commit message:\n\n${message}\n\n操作:`, [
    ...ACTIONS,
  ])) as Action | undefined;
}
