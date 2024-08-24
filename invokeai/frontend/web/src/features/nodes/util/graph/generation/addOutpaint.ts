import type { RootState } from 'app/store/store';
import type { CanvasManager } from 'features/controlLayers/konva/CanvasManager';
import { getPrefixedId } from 'features/controlLayers/konva/util';
import type { CanvasV2State, Dimensions } from 'features/controlLayers/store/types';
import type { Graph } from 'features/nodes/util/graph/generation/Graph';
import { getInfill } from 'features/nodes/util/graph/graphBuilderUtils';
import { isEqual } from 'lodash-es';
import type { Invocation } from 'services/api/types';

export const addOutpaint = async (
  state: RootState,
  g: Graph,
  manager: CanvasManager,
  l2i: Invocation<'l2i'>,
  denoise: Invocation<'denoise_latents'>,
  vaeSource: Invocation<'main_model_loader' | 'sdxl_model_loader' | 'seamless' | 'vae_loader'>,
  modelLoader: Invocation<'main_model_loader' | 'sdxl_model_loader'>,
  originalSize: Dimensions,
  scaledSize: Dimensions,
  bbox: CanvasV2State['bbox'],
  compositing: CanvasV2State['compositing'],
  denoising_start: number,
  fp32: boolean
): Promise<Invocation<'canvas_v2_mask_and_crop'>> => {
  denoise.denoising_start = denoising_start;

  const mode = state.canvasV2.session.mode;
  const initialImage = await manager.compositor.getCompositeRasterLayerImageDTO(bbox.rect);
  const maskImage = await manager.compositor.getCompositeInpaintMaskImageDTO(bbox.rect);
  const infill = getInfill(g, compositing);

  if (!isEqual(scaledSize, originalSize)) {
    // Scale before processing requires some resizing

    // Combine the inpaint mask and the initial image's alpha channel into a single mask
    const maskAlphaToMask = g.addNode({
      id: getPrefixedId('alpha_to_mask'),
      type: 'tomask',
      image: { image_name: maskImage.image_name },
      invert: true,
    });
    const initialImageAlphaToMask = g.addNode({
      id: getPrefixedId('image_alpha_to_mask'),
      type: 'tomask',
      image: { image_name: initialImage.image_name },
    });
    const maskCombine = g.addNode({
      id: getPrefixedId('mask_combine'),
      type: 'mask_combine',
    });
    g.addEdge(maskAlphaToMask, 'image', maskCombine, 'mask1');
    g.addEdge(initialImageAlphaToMask, 'image', maskCombine, 'mask2');

    // Resize the combined and initial image to the scaled size
    const resizeInputMaskToScaledSize = g.addNode({
      id: getPrefixedId('resize_mask_to_scaled_size'),
      type: 'img_resize',
      ...scaledSize,
    });
    g.addEdge(maskCombine, 'image', resizeInputMaskToScaledSize, 'image');

    // Resize the initial image to the scaled size and infill
    const resizeInputImageToScaledSize = g.addNode({
      id: getPrefixedId('resize_image_to_scaled_size'),
      type: 'img_resize',
      image: { image_name: initialImage.image_name },
      ...scaledSize,
    });
    g.addEdge(resizeInputImageToScaledSize, 'image', infill, 'image');

    // Create the gradient denoising mask from the combined mask
    const createGradientMask = g.addNode({
      id: getPrefixedId('create_gradient_mask'),
      type: 'create_gradient_mask',
      coherence_mode: compositing.canvasCoherenceMode,
      minimum_denoise: compositing.canvasCoherenceMinDenoise,
      edge_radius: compositing.canvasCoherenceEdgeSize,
      fp32,
    });
    g.addEdge(infill, 'image', createGradientMask, 'image');
    g.addEdge(resizeInputMaskToScaledSize, 'image', createGradientMask, 'mask');
    g.addEdge(vaeSource, 'vae', createGradientMask, 'vae');
    g.addEdge(modelLoader, 'unet', createGradientMask, 'unet');
    g.addEdge(createGradientMask, 'denoise_mask', denoise, 'denoise_mask');

    // Decode infilled image and connect to denoise
    const i2l = g.addNode({ id: getPrefixedId('i2l'), type: 'i2l', fp32 });
    g.addEdge(infill, 'image', i2l, 'image');
    g.addEdge(vaeSource, 'vae', i2l, 'vae');
    g.addEdge(i2l, 'latents', denoise, 'latents');

    // Resize the output image back to the original size
    const resizeOutputImageToOriginalSize = g.addNode({
      id: getPrefixedId('resize_image_to_original_size'),
      type: 'img_resize',
      ...originalSize,
    });
    const resizeOutputMaskToOriginalSize = g.addNode({
      id: getPrefixedId('resize_mask_to_original_size'),
      type: 'img_resize',
      ...originalSize,
    });
    const canvasPasteBack = g.addNode({
      id: getPrefixedId('canvas_v2_mask_and_crop'),
      type: 'canvas_v2_mask_and_crop',
      mask_blur: compositing.maskBlur,
    });

    // Resize initial image and mask to scaled size, feed into to gradient mask

    // After denoising, resize the image and mask back to original size
    g.addEdge(l2i, 'image', resizeOutputImageToOriginalSize, 'image');
    g.addEdge(createGradientMask, 'expanded_mask_area', resizeOutputMaskToOriginalSize, 'image');

    // Finally, paste the generated masked image back onto the original image
    g.addEdge(resizeOutputImageToOriginalSize, 'image', canvasPasteBack, 'generated_image');
    g.addEdge(resizeOutputMaskToOriginalSize, 'image', canvasPasteBack, 'mask');

    if (mode === 'generate') {
      canvasPasteBack.source_image = { image_name: initialImage.image_name };
    }

    return canvasPasteBack;
  } else {
    infill.image = { image_name: initialImage.image_name };
    // No scale before processing, much simpler
    const i2l = g.addNode({ id: getPrefixedId('i2l'), type: 'i2l', fp32 });
    const maskAlphaToMask = g.addNode({
      id: getPrefixedId('mask_alpha_to_mask'),
      type: 'tomask',
      image: { image_name: maskImage.image_name },
      invert: true,
    });
    const initialImageAlphaToMask = g.addNode({
      id: getPrefixedId('image_alpha_to_mask'),
      type: 'tomask',
      image: { image_name: initialImage.image_name },
    });
    const maskCombine = g.addNode({
      id: getPrefixedId('mask_combine'),
      type: 'mask_combine',
    });
    const createGradientMask = g.addNode({
      id: getPrefixedId('create_gradient_mask'),
      type: 'create_gradient_mask',
      coherence_mode: compositing.canvasCoherenceMode,
      minimum_denoise: compositing.canvasCoherenceMinDenoise,
      edge_radius: compositing.canvasCoherenceEdgeSize,
      fp32,
      image: { image_name: initialImage.image_name },
    });
    const canvasPasteBack = g.addNode({
      id: getPrefixedId('canvas_v2_mask_and_crop'),
      type: 'canvas_v2_mask_and_crop',
      mask_blur: compositing.maskBlur,
    });
    g.addEdge(maskAlphaToMask, 'image', maskCombine, 'mask1');
    g.addEdge(initialImageAlphaToMask, 'image', maskCombine, 'mask2');
    g.addEdge(maskCombine, 'image', createGradientMask, 'mask');
    g.addEdge(infill, 'image', i2l, 'image');
    g.addEdge(i2l, 'latents', denoise, 'latents');
    g.addEdge(vaeSource, 'vae', i2l, 'vae');
    g.addEdge(vaeSource, 'vae', createGradientMask, 'vae');
    g.addEdge(modelLoader, 'unet', createGradientMask, 'unet');
    g.addEdge(createGradientMask, 'denoise_mask', denoise, 'denoise_mask');
    g.addEdge(createGradientMask, 'expanded_mask_area', canvasPasteBack, 'mask');
    g.addEdge(l2i, 'image', canvasPasteBack, 'generated_image');

    if (mode === 'generate') {
      canvasPasteBack.source_image = { image_name: initialImage.image_name };
    }

    return canvasPasteBack;
  }
};
