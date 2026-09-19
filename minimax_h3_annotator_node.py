import torch
import numpy as np
from PIL import Image
import io
import base64

class MiniMaxH3CanvasAnnotator:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {},
            "optional": {
                "image": ("IMAGE",),
                "mode": ("STRING", {"default": "Overlay on Image"}),
                "canvas_data": ("STRING", {"default": "", "multiline": True}),
                "bg_data": ("STRING", {"default": "", "multiline": True}),
            }
        }

    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("clean_image", "annotated_image")
    FUNCTION = "process_canvas"
    CATEGORY = "MiniMax_H3"

    def process_canvas(self, mode="Overlay on Image", canvas_data="", bg_data="", image=None):
        # 1. 解析透明标注图层 (stroke_pil)
        stroke_pil = None
        if canvas_data and "," in canvas_data:
            try:
                header, encoded = canvas_data.split(",", 1)
                stroke_bytes = base64.b64decode(encoded)
                stroke_pil = Image.open(io.BytesIO(stroke_bytes)).convert("RGBA")
            except Exception as e:
                print(f"[MiniMax H3 Canvas] canvas_data decode error: {e}")

        # 2. 解析基础 Clean 底图 (base_pil)
        if image is not None and mode == "Overlay on Image":
            i = 255.0 * image[0].cpu().numpy()
            base_pil = Image.fromarray(np.clip(i, 0, 255).astype(np.uint8)).convert("RGBA")
        elif bg_data and "," in bg_data:
            header, encoded = bg_data.split(",", 1)
            bg_bytes = base64.b64decode(encoded)
            base_pil = Image.open(io.BytesIO(bg_bytes)).convert("RGBA")
        else:
            base_color = (0, 0, 0, 255) if mode == "Overlay on Image" else (255, 255, 255, 255)
            init_size = stroke_pil.size if stroke_pil else (1024, 1024)
            base_pil = Image.new("RGBA", init_size, base_color)

        # 3. 统一分辨率对齐逻辑：以高分辨率为基准
        if stroke_pil is not None:
            if image is not None and mode == "Overlay on Image":
                # 有上游图像节点输入时，以连线图像尺寸为准
                if stroke_pil.size != base_pil.size:
                    stroke_pil = stroke_pil.resize(base_pil.size, Image.Resampling.LANCZOS)
            else:
                # 无上游连线时，若底图（压缩背景）尺寸小于标注层，放大底图向上对齐
                if base_pil.width * base_pil.height < stroke_pil.width * stroke_pil.height:
                    base_pil = base_pil.resize(stroke_pil.size, Image.Resampling.LANCZOS)
                elif base_pil.size != stroke_pil.size:
                    stroke_pil = stroke_pil.resize(base_pil.size, Image.Resampling.LANCZOS)

        # 4. 构建 Clean Image Tensor
        clean_np = np.array(base_pil.convert("RGB")).astype(np.float32) / 255.0
        clean_tensor = torch.from_numpy(clean_np).unsqueeze(0)

        # 5. 合成全要素 Annotated Image Tensor
        annotated_pil = base_pil.copy()
        if stroke_pil is not None:
            annotated_pil.alpha_composite(stroke_pil)

        annotated_np = np.array(annotated_pil.convert("RGB")).astype(np.float32) / 255.0
        annotated_tensor = torch.from_numpy(annotated_np).unsqueeze(0)

        return (clean_tensor, annotated_tensor)

NODE_CLASS_MAPPINGS = {
    "MiniMax_H3_CanvasAnnotator": MiniMaxH3CanvasAnnotator
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMax_H3_CanvasAnnotator": "MiniMax H3 Canvas Annotator 🎨"
}