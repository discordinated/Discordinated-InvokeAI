import { rgbColorToString } from 'common/util/colorCodeTransformers';
import { CanvasBrushLine } from 'features/controlLayers/konva/CanvasBrushLine';
import { CanvasEraserLine } from 'features/controlLayers/konva/CanvasEraserLine';
import type { CanvasManager } from 'features/controlLayers/konva/CanvasManager';
import { CanvasRect } from 'features/controlLayers/konva/CanvasRect';
import { getNodeBboxFast } from 'features/controlLayers/konva/entityBbox';
import { mapId } from 'features/controlLayers/konva/util';
import type { BrushLine, EraserLine, InpaintMaskEntity, RectShape } from 'features/controlLayers/store/types';
import { isDrawingTool, RGBA_RED } from 'features/controlLayers/store/types';
import Konva from 'konva';
import { assert } from 'tsafe';

export class CanvasInpaintMask {
  static NAME_PREFIX = 'inpaint-mask';
  static LAYER_NAME = `${CanvasInpaintMask.NAME_PREFIX}_layer`;
  static TRANSFORMER_NAME = `${CanvasInpaintMask.NAME_PREFIX}_transformer`;
  static GROUP_NAME = `${CanvasInpaintMask.NAME_PREFIX}_group`;
  static OBJECT_GROUP_NAME = `${CanvasInpaintMask.NAME_PREFIX}_object-group`;
  static COMPOSITING_RECT_NAME = `${CanvasInpaintMask.NAME_PREFIX}_compositing-rect`;

  private drawingBuffer: BrushLine | EraserLine | RectShape | null;
  private inpaintMaskState: InpaintMaskEntity;

  id = 'inpaint_mask';
  manager: CanvasManager;

  konva: {
    layer: Konva.Layer;
    group: Konva.Group;
    objectGroup: Konva.Group;
    transformer: Konva.Transformer;
    compositingRect: Konva.Rect;
  };
  objects: Map<string, CanvasBrushLine | CanvasEraserLine | CanvasRect>;

  constructor(entity: InpaintMaskEntity, manager: CanvasManager) {
    this.manager = manager;

    this.konva = {
      layer: new Konva.Layer({ name: CanvasInpaintMask.LAYER_NAME }),
      group: new Konva.Group({ name: CanvasInpaintMask.GROUP_NAME, listening: false }),
      objectGroup: new Konva.Group({ name: CanvasInpaintMask.OBJECT_GROUP_NAME, listening: false }),
      transformer: new Konva.Transformer({
        name: CanvasInpaintMask.TRANSFORMER_NAME,
        shouldOverdrawWholeArea: true,
        draggable: true,
        dragDistance: 0,
        enabledAnchors: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
        rotateEnabled: false,
        flipEnabled: false,
      }),
      compositingRect: new Konva.Rect({ name: CanvasInpaintMask.COMPOSITING_RECT_NAME, listening: false }),
    };

    this.konva.group.add(this.konva.objectGroup);
    this.konva.layer.add(this.konva.group);

    this.konva.transformer.on('transformend', () => {
      this.manager.stateApi.onScaleChanged(
        {
          id: this.id,
          scale: this.konva.group.scaleX(),
          position: { x: this.konva.group.x(), y: this.konva.group.y() },
        },
        'inpaint_mask'
      );
    });
    this.konva.transformer.on('dragend', () => {
      this.manager.stateApi.onPosChanged(
        { id: this.id, position: { x: this.konva.group.x(), y: this.konva.group.y() } },
        'inpaint_mask'
      );
    });
    this.konva.layer.add(this.konva.transformer);

    this.konva.group.add(this.konva.compositingRect);
    this.objects = new Map();
    this.drawingBuffer = null;
    this.inpaintMaskState = entity;
  }

  destroy(): void {
    this.konva.layer.destroy();
  }

  getDrawingBuffer() {
    return this.drawingBuffer;
  }

  async setDrawingBuffer(obj: BrushLine | EraserLine | RectShape | null) {
    this.drawingBuffer = obj;
    if (this.drawingBuffer) {
      if (this.drawingBuffer.type === 'brush_line') {
        this.drawingBuffer.color = RGBA_RED;
      } else if (this.drawingBuffer.type === 'rect_shape') {
        this.drawingBuffer.color = RGBA_RED;
      }

      await this.renderObject(this.drawingBuffer, true);
      this.updateGroup(true);
    }
  }

  finalizeDrawingBuffer() {
    if (!this.drawingBuffer) {
      return;
    }
    if (this.drawingBuffer.type === 'brush_line') {
      this.manager.stateApi.onBrushLineAdded({ id: this.id, brushLine: this.drawingBuffer }, 'inpaint_mask');
    } else if (this.drawingBuffer.type === 'eraser_line') {
      this.manager.stateApi.onEraserLineAdded({ id: this.id, eraserLine: this.drawingBuffer }, 'inpaint_mask');
    } else if (this.drawingBuffer.type === 'rect_shape') {
      this.manager.stateApi.onRectShapeAdded({ id: this.id, rectShape: this.drawingBuffer }, 'inpaint_mask');
    }
    this.setDrawingBuffer(null);
  }

  async render(inpaintMaskState: InpaintMaskEntity) {
    this.inpaintMaskState = inpaintMaskState;

    // Update the layer's position and listening state
    this.konva.group.setAttrs({
      x: inpaintMaskState.position.x,
      y: inpaintMaskState.position.y,
      scaleX: 1,
      scaleY: 1,
    });

    let didDraw = false;

    const objectIds = inpaintMaskState.objects.map(mapId);
    // Destroy any objects that are no longer in state
    for (const object of this.objects.values()) {
      if (!objectIds.includes(object.id)) {
        this.objects.delete(object.id);
        object.destroy();
        didDraw = true;
      }
    }

    for (const obj of inpaintMaskState.objects) {
      if (await this.renderObject(obj)) {
        didDraw = true;
      }
    }

    if (this.drawingBuffer) {
      if (await this.renderObject(this.drawingBuffer)) {
        didDraw = true;
      }
    }

    this.updateGroup(didDraw);
  }

  private async renderObject(obj: InpaintMaskEntity['objects'][number], force = false): Promise<boolean> {
    if (obj.type === 'brush_line') {
      let brushLine = this.objects.get(obj.id);
      assert(brushLine instanceof CanvasBrushLine || brushLine === undefined);

      if (!brushLine) {
        brushLine = new CanvasBrushLine(obj);
        this.objects.set(brushLine.id, brushLine);
        this.konva.objectGroup.add(brushLine.konva.group);
        return true;
      } else {
        if (brushLine.update(obj, force)) {
          return true;
        }
      }
    } else if (obj.type === 'eraser_line') {
      let eraserLine = this.objects.get(obj.id);
      assert(eraserLine instanceof CanvasEraserLine || eraserLine === undefined);

      if (!eraserLine) {
        eraserLine = new CanvasEraserLine(obj);
        this.objects.set(eraserLine.id, eraserLine);
        this.konva.objectGroup.add(eraserLine.konva.group);
        return true;
      } else {
        if (eraserLine.update(obj, force)) {
          return true;
        }
      }
    } else if (obj.type === 'rect_shape') {
      let rect = this.objects.get(obj.id);
      assert(rect instanceof CanvasRect || rect === undefined);

      if (!rect) {
        rect = new CanvasRect(obj);
        this.objects.set(rect.id, rect);
        this.konva.objectGroup.add(rect.konva.group);
        return true;
      } else {
        if (rect.update(obj, force)) {
          return true;
        }
      }
    }

    return false;
  }

  updateGroup(didDraw: boolean) {
    this.konva.layer.visible(this.inpaintMaskState.isEnabled);

    // The user is allowed to reduce mask opacity to 0, but we need the opacity for the compositing rect to work
    this.konva.group.opacity(1);

    if (didDraw) {
      // Convert the color to a string, stripping the alpha - the object group will handle opacity.
      const rgbColor = rgbColorToString(this.inpaintMaskState.fill);
      const maskOpacity = this.manager.stateApi.getMaskOpacity();

      this.konva.compositingRect.setAttrs({
        // The rect should be the size of the layer - use the fast method if we don't have a pixel-perfect bbox already
        ...getNodeBboxFast(this.konva.objectGroup),
        fill: rgbColor,
        opacity: maskOpacity,
        // Draw this rect only where there are non-transparent pixels under it (e.g. the mask shapes)
        globalCompositeOperation: 'source-in',
        visible: true,
        // This rect must always be on top of all other shapes
        zIndex: this.objects.size + 1,
      });
    }

    const isSelected = this.manager.stateApi.getIsSelected(this.id);
    const selectedTool = this.manager.stateApi.getToolState().selected;

    if (this.objects.size === 0) {
      // If the layer is totally empty, reset the cache and bail out.
      this.konva.layer.listening(false);
      this.konva.transformer.nodes([]);
      if (this.konva.group.isCached()) {
        this.konva.group.clearCache();
      }
      return;
    }

    if (isSelected && selectedTool === 'move') {
      // When the layer is selected and being moved, we should always cache it.
      // We should update the cache if we drew to the layer.
      if (!this.konva.group.isCached() || didDraw) {
        this.konva.group.cache();
      }
      // Activate the transformer
      this.konva.layer.listening(true);
      this.konva.transformer.nodes([this.konva.group]);
      this.konva.transformer.forceUpdate();
      return;
    }

    if (isSelected && selectedTool !== 'move') {
      // If the layer is selected but not using the move tool, we don't want the layer to be listening.
      this.konva.layer.listening(false);
      // The transformer also does not need to be active.
      this.konva.transformer.nodes([]);
      if (isDrawingTool(selectedTool)) {
        // We are using a drawing tool (brush, eraser, rect). These tools change the layer's rendered appearance, so we
        // should never be cached.
        if (this.konva.group.isCached()) {
          this.konva.group.clearCache();
        }
      } else {
        // We are using a non-drawing tool (move, view, bbox), so we should cache the layer.
        // We should update the cache if we drew to the layer.
        if (!this.konva.group.isCached() || didDraw) {
          this.konva.group.cache();
        }
      }
      return;
    }

    if (!isSelected) {
      // Unselected layers should not be listening
      this.konva.layer.listening(false);
      // The transformer also does not need to be active.
      this.konva.transformer.nodes([]);
      // Update the layer's cache if it's not already cached or we drew to it.
      if (!this.konva.group.isCached() || didDraw) {
        this.konva.group.cache();
      }

      return;
    }
  }
}