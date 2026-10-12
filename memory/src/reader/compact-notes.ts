import { COMPACT_NOTE } from "../model/anchor";

/**
 * Source evaluated inside the reader window. It swaps the note renderer so that note icons
 * are drawn at the compact size, and narrows hit testing to the smaller icon. Patches are
 * kept on the prototypes, so calling it again with `enabled = false` restores the originals.
 */
export function compactNotesScript(enabled: boolean): string {
  return `(() => {
    const enabled = ${enabled ? "true" : "false"};
    const icon = ${COMPACT_NOTE.icon};
    const compact = ${COMPACT_NOTE.compact};
    const shift = ${COMPACT_NOTE.shift};
    const view = window._reader?._primaryView;
    const state = window.__memoryCompactNotes || (window.__memoryCompactNotes = { renderers: [], views: [] });
    let changed = false;

    const pageOf = (owner, pageIndex) =>
      owner?.getPageByIndex?.(pageIndex)
      || owner?._pages?.find?.((page) => page?._pageIndex === pageIndex)
      || owner?._pages?.[pageIndex];

    const hit = (owner, annotation, position) => {
      const noteRect = annotation?.position?.rects?.[0];
      const pointerRect = position?.rects?.[0];
      if (!noteRect || !pointerRect) return null;
      const renderer = pageOf(owner, annotation.position.pageIndex)?._pageRenderer;
      if (typeof renderer?._p2v !== "function") return null;
      const note = renderer._p2v(annotation.position)?.rects?.[0];
      const pointer = renderer._p2v(position)?.rects?.[0];
      const scale = Number(renderer._scale);
      if (!note || !pointer || !(scale > 0)) return null;
      const left = note[0] + shift * scale;
      const top = note[1] + shift * scale;
      const x = (pointer[0] + pointer[2]) / 2;
      const y = (pointer[1] + pointer[3]) / 2;
      return x >= left && x <= left + compact * scale && y >= top && y <= top + compact * scale;
    };

    const patchRenderer = (renderer) => {
      const prototype = renderer && Object.getPrototypeOf(renderer);
      if (!prototype || typeof prototype._drawNote !== "function") return;
      let entry = state.renderers.find((item) => item.prototype === prototype);
      if (!entry) {
        entry = { prototype, original: prototype._drawNote, enabled: false, wrapped: null };
        entry.wrapped = function (annotation) {
          if (!entry.enabled || !this._context || typeof this._p2v !== "function") {
            return entry.original.call(this, annotation);
          }
          const viewRect = this._p2v(annotation.position)?.rects?.[0];
          const scale = Number(this._scale);
          if (!viewRect || !(scale > 0) || typeof this._drawNoteIcon !== "function") {
            return entry.original.call(this, annotation);
          }
          const factor = scale * compact / icon;
          this._context.save();
          this._context.transform(factor, 0, 0, factor, viewRect[0] + shift * scale, viewRect[1] + shift * scale);
          this._drawNoteIcon(this._context, annotation.color);
          this._context.restore();
        };
        state.renderers.push(entry);
      }
      entry.enabled = enabled;
      if (enabled && prototype._drawNote !== entry.wrapped) {
        entry.original = prototype._drawNote;
        prototype._drawNote = entry.wrapped;
        changed = true;
      }
      if (!enabled && prototype._drawNote === entry.wrapped) {
        prototype._drawNote = entry.original;
        changed = true;
      }
    };

    const patchView = (owner) => {
      const prototype = owner && Object.getPrototypeOf(owner);
      if (!prototype || typeof prototype.getSelectableAnnotations !== "function") return;
      let entry = state.views.find((item) => item.prototype === prototype);
      if (!entry) {
        entry = {
          prototype,
          selectable: prototype.getSelectableAnnotations,
          action: prototype.getSelectedAnnotationAction,
          enabled: false,
        };
        entry.selectableWrapped = function (position) {
          const result = entry.selectable.apply(this, arguments);
          if (!entry.enabled || !Array.isArray(result)) return result;
          return result.filter((annotation) => annotation?.type !== "note" || hit(this, annotation, position) !== false);
        };
        entry.actionWrapped = function (annotation, position) {
          if (entry.enabled && annotation?.type === "note" && hit(this, annotation, position) === false) return null;
          return entry.action.apply(this, arguments);
        };
        state.views.push(entry);
      }
      entry.enabled = enabled;
      if (enabled) {
        if (prototype.getSelectableAnnotations !== entry.selectableWrapped) {
          entry.selectable = prototype.getSelectableAnnotations;
          prototype.getSelectableAnnotations = entry.selectableWrapped;
          changed = true;
        }
        if (typeof prototype.getSelectedAnnotationAction === "function"
            && prototype.getSelectedAnnotationAction !== entry.actionWrapped) {
          entry.action = prototype.getSelectedAnnotationAction;
          prototype.getSelectedAnnotationAction = entry.actionWrapped;
          changed = true;
        }
      } else {
        if (prototype.getSelectableAnnotations === entry.selectableWrapped) {
          prototype.getSelectableAnnotations = entry.selectable;
          changed = true;
        }
        if (prototype.getSelectedAnnotationAction === entry.actionWrapped) {
          prototype.getSelectedAnnotationAction = entry.action;
          changed = true;
        }
      }
    };

    if (view) {
      patchView(view);
      for (const page of view._pages || []) {
        patchRenderer(page?._pageRenderer);
        patchRenderer(page?._detailRenderer);
      }
    }
    if (changed) {
      for (const page of view?._pages || []) {
        page?._pageRenderer?._invalidateSignature?.();
        page?._detailRenderer?._invalidateSignature?.();
        page?.render?.();
      }
    }
    return true;
  })()`;
}
