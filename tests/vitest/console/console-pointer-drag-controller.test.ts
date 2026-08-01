// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createConsolePointerDragController } from "../../../apps/console/composables/console-pointer-drag-controller";

function pointerEvent(type: string, currentTarget?: Element): PointerEvent {
  const event: any = new Event(type) as PointerEvent;
  if (currentTarget) {
    Object.defineProperty(event, "currentTarget", {
      configurable: true,
      value: currentTarget,
    });
  }
  return event;
}

describe("console pointer drag controller", () : any => {
  it("starts drag state, applies body styles, forwards pointer moves, and restores on pointerup", () : any => {
    const target: any = document.createElement("button");
    document.body.appendChild(target);
    document.body.style.cursor = "default";
    document.body.style.userSelect = "text";

    const onMove: any = vi.fn();
    const onStop: any = vi.fn();
    const controller: any = createConsolePointerDragController({
      cursor: "col-resize",
      onMove,
      onStop,
    });

    controller.handlePointerMove(pointerEvent("pointermove"));
    expect(onMove).not.toHaveBeenCalled();

    controller.startPointerDrag(pointerEvent("pointerdown", target));
    expect(controller.dragging.value).toBe(true);
    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");

    const moveEvent: any = pointerEvent("pointermove");
    document.dispatchEvent(moveEvent);
    expect(onMove).toHaveBeenCalledWith(moveEvent);

    document.dispatchEvent(pointerEvent("pointerup"));
    expect(controller.dragging.value).toBe(false);
    expect(document.body.style.cursor).toBe("default");
    expect(document.body.style.userSelect).toBe("text");
    expect(onStop).toHaveBeenCalledTimes(1);

    document.dispatchEvent(pointerEvent("pointermove"));
    expect(onMove).toHaveBeenCalledTimes(1);
  });

  it("stops on pointercancel and is idempotent when already stopped", () : any => {
    const target: any = document.createElement("div");
    document.body.appendChild(target);
    const onStop: any = vi.fn();
    const controller: any = createConsolePointerDragController({
      onMove: vi.fn(),
      onStop,
    });

    controller.stopPointerDrag();
    expect(onStop).not.toHaveBeenCalled();

    controller.startPointerDrag(pointerEvent("pointerdown", target));
    expect(controller.dragging.value).toBe(true);
    expect(document.body.style.userSelect).toBe("none");

    document.dispatchEvent(pointerEvent("pointercancel"));
    expect(controller.dragging.value).toBe(false);
    expect(onStop).toHaveBeenCalledTimes(1);

    controller.stopPointerDrag();
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("restarting a drag removes old listeners before binding the next document", () : any => {
    const firstTarget: any = document.createElement("div");
    const secondTarget: any = document.createElement("div");
    document.body.append(firstTarget, secondTarget);
    const onMove: any = vi.fn();
    const onStop: any = vi.fn();
    const controller: any = createConsolePointerDragController({
      cursor: "move",
      onMove,
      onStop,
    });

    controller.startPointerDrag(pointerEvent("pointerdown", firstTarget));
    expect(controller.dragging.value).toBe(true);

    controller.startPointerDrag(pointerEvent("pointerdown", secondTarget));
    expect(controller.dragging.value).toBe(true);
    expect(onStop).toHaveBeenCalledTimes(1);

    const moveEvent: any = pointerEvent("pointermove");
    document.dispatchEvent(moveEvent);
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith(moveEvent);

    controller.stopPointerDrag();
    expect(onStop).toHaveBeenCalledTimes(2);
  });
});
