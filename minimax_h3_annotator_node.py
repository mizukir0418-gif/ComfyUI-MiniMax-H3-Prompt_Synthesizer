import os
import json
import io
import base64
import torch
import numpy as np
from PIL import Image, ImageOps
import folder_paths

class MiniMaxH3CanvasAnnotator:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {},
            "optional": {
                "image": ("IMAGE",),
                "canvas_data": ("STRING", {"default": "", "multiline": True}),
                "bg_data": ("STRING", {"default": "", "multiline": True}),
            }
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "MASK")
    RETURN_NAMES = ("clean_image", "annotated_image", "mask")
    FUNCTION = "process_canvas"
    CATEGORY = "MiniMax_H3"

    def process_canvas(self, canvas_data="", bg_data="", image=None):
        # 1. 解析前端传来的舞台元数据 (JSON 格式)
        bg_meta = {}
        if bg_data and bg_data.strip().startswith("{"):
            try:
                bg_meta = json.loads(bg_data)
            except Exception as e:
                print(f"[MiniMax H3 Canvas] bg_data JSON parse error: {e}")

        # 2. 解码透明标注与贴纸层 (stroke_pil, RGBA)
        stroke_pil = None
        if canvas_data and "," in canvas_data:
            try:
                _, encoded = canvas_data.split(",", 1)
                stroke_bytes = base64.b64decode(encoded)
                stroke_pil = Image.open(io.BytesIO(stroke_bytes)).convert("RGBA")
            except Exception as e:
                print(f"[MiniMax H3 Canvas] canvas_data decode error: {e}")

        # 3. 构建 100% 纯净、无绿幕的 clean_tensor [B, H, W, 3]
        if image is not None:
            clean_tensor = image.detach().cpu().contiguous().float()
        else:
            clean_pil = None
            filename = bg_meta.get("filename")
            if filename:
                input_dir = folder_paths.get_input_directory()
                img_path = os.path.join(input_dir, filename)
                if os.path.isfile(img_path):
                    try:
                        img_raw = Image.open(img_path)
                        clean_pil = ImageOps.exif_transpose(img_raw).convert("RGB")
                    except Exception as e:
                        print(f"[MiniMax H3 Canvas] Failed to load input file {filename}: {e}")

            if clean_pil is None:
                vp = bg_meta.get("viewport", {})
                w = int(vp.get("w", 1024))
                h = int(vp.get("h", 1024))
                clean_pil = Image.new("RGB", (w, h), (0, 0, 0))

            clean_np = np.array(clean_pil).astype(np.float32) / 255.0
            clean_tensor = torch.from_numpy(clean_np).unsqueeze(0).contiguous()

        B, H, W, _ = clean_tensor.shape

        # 4. 计算绿幕扩边舞台尺寸与视口偏移 (支持四边独立绿幕扩边)
        pad = bg_meta.get("stagePadding", {"top": 0, "right": 0, "bottom": 0, "left": 0})
        vp_meta = bg_meta.get("viewport", {"w": W, "h": H})
        vp_w = max(1, float(vp_meta.get("w", W)))
        vp_h = max(1, float(vp_meta.get("h", H)))

        # 按 clean_tensor 实际物理分辨率等比换算绿幕边距
        scale_x = W / vp_w
        scale_y = H / vp_h
        pad_left = max(0, int(round(pad.get("left", 0) * scale_x)))
        pad_right = max(0, int(round(pad.get("right", 0) * scale_x)))
        pad_top = max(0, int(round(pad.get("top", 0) * scale_y)))
        pad_bottom = max(0, int(round(pad.get("bottom", 0) * scale_y)))

        stage_W = W + pad_left + pad_right
        stage_H = H + pad_top + pad_bottom

        # 5. 构建带绿幕备演区的合成舞台基底 stage_tensor [B, stage_H, stage_W, 3]
        if pad_left > 0 or pad_right > 0 or pad_top > 0 or pad_bottom > 0:
            # 标准绿幕色 #00B140 -> RGB (0, 177, 64)
            chroma_color = torch.tensor([0.0, 177.0 / 255.0, 64.0 / 255.0], dtype=torch.float32).view(1, 1, 1, 3)
            stage_tensor = chroma_color.expand(B, stage_H, stage_W, 3).clone().contiguous()
            stage_tensor[:, pad_top:pad_top + H, pad_left:pad_left + W, :] = clean_tensor
        else:
            stage_tensor = clean_tensor.clone()

        # 6. 若无笔触与贴纸，直接返回
        if stroke_pil is None:
            mask_tensor = torch.zeros((B, H, W), dtype=torch.float32)
            return (clean_tensor, stage_tensor, mask_tensor)

        if stroke_pil.size != (stage_W, stage_H):
            stroke_pil = stroke_pil.resize((stage_W, stage_H), Image.Resampling.BILINEAR)

        # 7. 向量化合成 annotated_tensor [B, stage_H, stage_W, 3]
        stroke_np = np.array(stroke_pil).astype(np.float32) / 255.0
        stroke_rgb = torch.from_numpy(stroke_np[..., :3]).contiguous()
        stroke_alpha = torch.from_numpy(stroke_np[..., 3:4]).contiguous()

        annotated_tensor = stage_tensor * (1.0 - stroke_alpha) + stroke_rgb * stroke_alpha
        annotated_tensor = torch.clamp(annotated_tensor, 0.0, 1.0).contiguous()

        # 8. 严格裁剪出与 clean_image (W, H) 1:1 对齐的 mask_tensor [B, H, W]
        cropped_alpha = stroke_alpha[pad_top:pad_top + H, pad_left:pad_left + W, 0]
        mask_tensor = cropped_alpha.unsqueeze(0).expand(B, -1, -1).contiguous()

        del stroke_pil, stroke_np
        return (clean_tensor, annotated_tensor, mask_tensor)

NODE_CLASS_MAPPINGS = {
    "MiniMax_H3_CanvasAnnotator": MiniMaxH3CanvasAnnotator
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMax_H3_CanvasAnnotator": "MiniMax H3 Canvas Annotator 🎨"
}