import os
import re
import socket
import ipaddress
import uuid
import urllib.parse
import base64
import aiohttp
from aiohttp import web
from server import PromptServer
import folder_paths

# =====================================================================
# 🛡️ 1. 安全防御与跨域图片验证 API
# =====================================================================

def verify_and_get_safe_ips(hostname):
    try:
        addr_info = socket.getaddrinfo(hostname, None)
        safe_ips = []
        for item in addr_info:
            family, _, _, _, sockaddr = item
            ip_str = sockaddr[0].split('%')[0] if '%' in sockaddr[0] else sockaddr[0]
            ip = ipaddress.ip_address(ip_str)
            if ip.is_private or ip.is_loopback or ip.is_link_local:
                return False, []
            safe_ips.append(ip_str)
        return (True, safe_ips) if safe_ips else (False, [])
    except Exception:
        return False, []

def sanitize_filename(filename):
    """清洗文件名，防止非法字符与路径穿越"""
    filename = re.sub(r'[\\/*?:"<>|]', "", filename)
    filename = filename.strip(". ")
    return filename if filename else f"sticker_{uuid.uuid4().hex[:8]}"

def verify_image_dna(file_path):
    try:
        if not os.path.exists(file_path):
            return False
        with open(file_path, "rb") as f:
            header = f.read(16)
        if header.startswith(b'\x89PNG\r\n\x1a\n'): return "png"
        if header.startswith(b'\xff\xd8\xff'): return "jpeg"
        if header.startswith(b'GIF87a') or header.startswith(b'GIF89a'): return "gif"
        if header.startswith(b'RIFF') and b'WEBP' in header: return "webp"
        if header.startswith(b'BM'): return "bmp"
        return False
    except Exception:
        return False

@PromptServer.instance.routes.post("/anima/upload_url")
async def upload_url_route(request):
    temp_target_path = None
    try:
        data = await request.json()
        url = data.get("url")
        if not url:
            return web.json_response({"success": False, "error": "Invalid image URL"}, status=400)
            
        parsed_url = urllib.parse.urlparse(url)
        if parsed_url.scheme not in ("http", "https") or not parsed_url.hostname:
            return web.json_response({"success": False, "error": "Illegal protocol or hostname"}, status=403)

        is_safe, _ = verify_and_get_safe_ips(parsed_url.hostname)
        if not is_safe:
            return web.json_response({"success": False, "error": "Forbidden private network address"}, status=403)
            
        input_dir = folder_paths.get_input_directory()
        raw_name = os.path.basename(parsed_url.path) or f"anima_drag_{uuid.uuid4().hex[:8]}.png"
        safe_name = sanitize_filename(raw_name)
        temp_target_path = os.path.join(input_dir, f"{safe_name}_{uuid.uuid4().hex[:4]}.downloading")

        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Referer": f"{parsed_url.scheme}://{parsed_url.netloc}/"
        }

        timeout_client = aiohttp.ClientTimeout(total=15)
        async with aiohttp.ClientSession(timeout=timeout_client) as session:
            async with session.get(url, headers=headers) as response:
                if response.status != 200:
                    return web.json_response({"success": False, "error": f"HTTP {response.status}"}, status=400)
                
                with open(temp_target_path, "wb") as f:
                    async for chunk in response.content.iter_chunked(8192):
                        f.write(chunk)

        actual_type = verify_image_dna(temp_target_path)
        if not actual_type:
            if os.path.exists(temp_target_path): 
                os.remove(temp_target_path)
            return web.json_response({"success": False, "error": "Corrupted or invalid image file"}, status=400)

        final_filename = f"{os.path.splitext(safe_name)[0]}.{actual_type}"
        final_target_path = os.path.join(input_dir, final_filename)
        os.replace(temp_target_path, final_target_path)
        return web.json_response({"success": True, "name": final_filename})

    except Exception as e:
        if temp_target_path and os.path.exists(temp_target_path): 
            os.remove(temp_target_path)
        return web.json_response({"success": False, "error": str(e)}, status=500)


# =====================================================================
# 🌟 2. 扁平化本地贴纸库 API (直读流式接口，彻底解决 404 裂图)
# =====================================================================

def get_stickers_root():
    base_dir = os.path.dirname(os.path.realpath(__file__))
    stickers_dir = os.path.join(base_dir, "web", "stickers")
    os.makedirs(stickers_dir, exist_ok=True)
    return stickers_dir

@PromptServer.instance.routes.get("/minimax/stickers")
async def get_stickers_list(request):
    try:
        stickers_dir = get_stickers_root()
        valid_exts = ('.png', '.webp', '.jpg', '.jpeg', '.svg')
        stickers = []

        # 扫描 stickers 根目录（兼容旧子文件夹中的图片自动汇总展示）
        for root, _, files in os.walk(stickers_dir):
            for file in sorted(files):
                if file.lower().endswith(valid_exts):
                    rel_file = os.path.relpath(os.path.join(root, file), stickers_dir).replace("\\", "/")
                    stickers.append({
                        "name": os.path.splitext(file)[0],
                        "filename": rel_file,
                        "url": f"/minimax/stickers/image?name={urllib.parse.quote(rel_file)}"
                    })

        return web.json_response({"success": True, "stickers": stickers})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)

@PromptServer.instance.routes.get("/minimax/stickers/image")
async def get_sticker_image(request):
    try:
        rel_name = request.query.get("name", "")
        if not rel_name or ".." in rel_name:
            return web.Response(status=403)
        stickers_dir = get_stickers_root()
        file_path = os.path.normpath(os.path.join(stickers_dir, rel_name))
        if not file_path.startswith(os.path.normpath(stickers_dir)) or not os.path.isfile(file_path):
            return web.Response(status=404)
        return web.FileResponse(file_path)
    except Exception:
        return web.Response(status=500)

@PromptServer.instance.routes.post("/minimax/stickers/save")
async def save_sticker_route(request):
    try:
        data = await request.json()
        raw_name = data.get("name", "custom_sticker")
        image_data = data.get("image_data", "")

        if not image_data or "," not in image_data:
            return web.json_response({"success": False, "error": "Invalid base64 image data"}, status=400)

        stickers_dir = get_stickers_root()
        safe_name = sanitize_filename(raw_name)
        filename = f"{safe_name}.png"
        file_path = os.path.join(stickers_dir, filename)

        _, encoded = image_data.split(",", 1)
        img_bytes = base64.b64decode(encoded)
        with open(file_path, "wb") as f:
            f.write(img_bytes)

        return web.json_response({
            "success": True,
            "name": safe_name,
            "filename": filename,
            "url": f"/minimax/stickers/image?name={urllib.parse.quote(filename)}"
        })
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)

@PromptServer.instance.routes.post("/minimax/stickers/delete")
async def delete_sticker_route(request):
    try:
        data = await request.json()
        rel_name = data.get("filename", "")
        if not rel_name or ".." in rel_name:
            return web.json_response({"success": False, "error": "Invalid filename"}, status=403)
        stickers_dir = get_stickers_root()
        file_path = os.path.normpath(os.path.join(stickers_dir, rel_name))
        if file_path.startswith(os.path.normpath(stickers_dir)) and os.path.isfile(file_path):
            os.remove(file_path)
            return web.json_response({"success": True})
        return web.json_response({"success": False, "error": "File not found"}, status=404)
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


# =====================================================================
# 🧩 3. MiniMax H3 提示词合成节点
# =====================================================================

class MiniMaxH3PromptSynthesizer:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "subject_and_pose": ("STRING", {"multiline": True, "default": "2D anime style, in Image 1, (S1) black-haired girl hugs (S2) blonde girl from behind."}),
                "action_and_movement": ("STRING", {"multiline": True, "default": "(S1) whispers with a smirk while (S2) blushes intensely."}),
                "language": (["EN", "CN"], {"default": "EN"}),
                
                "shot_type": ([
                    "none",
                    "Extreme Close-up (ECU) [超特写镜头]",
                    "Close-up (CU) [特写镜头]",
                    "Medium Close-up (MCU) [近景镜头]",
                    "Medium Shot (MS) [中景镜头]",
                    "Knee Shot / Cowboy Shot [七分景镜头]",
                    "Full Shot / Wide Shot (WS) [全景/远景镜头]",
                    "Extreme Wide Shot (EWS) [大远景/环境建立镜头]"
                ], {"default": "Medium Close-up (MCU) [近景镜头]"}),
                
                "perspective": ([
                    "none",
                    "Eye-level shot [平视视角]",
                    "Low angle shot [仰视视角]",
                    "High angle shot [俯视视角]",
                    "Over-the-shoulder shot (OTS) [过肩视角]",
                    "POV shot (First-person point of view) [第一人称视角]",
                    "Bird's-eye view / Top-down shot [鸟瞰/正上方俯视]",
                    "Frog's-eye view [贴地极低视角]",
                    "Dutch angle / Tilted shot [倾斜视角]"
                ], {"default": "Eye-level shot [平视视角]"}),
                
                "lens_optics": ([
                    "none",
                    "Standard 35mm lens [35mm标准电影镜头]",
                    "50mm portrait lens [50mm人像焦段]",
                    "85mm telephoto lens, strong bokeh [85mm长焦背景虚化]",
                    "24mm wide-angle lens [24mm广角镜头]",
                    "Fisheye lens, extreme distortion [鱼眼镜头极限畸变]",
                    "Shallow depth of field, rack focus [浅景深与焦点转移]",
                    "Macro lens [微距镜头]",
                    "35mm cinematic film grain [35mm胶片颗粒质感]",
                    "Anamorphic lens flare [变形宽银幕横向炫光]"
                ], {"default": "Shallow depth of field, rack focus [浅景深与焦点转移]"}),
                
                "camera_movement": ([
                    "none",
                    "Static shot [固定镜头]",
                    "Dolly push in [推镜头]",
                    "Dolly pull back [拉镜头]",
                    "Tracking shot / Following shot [移动跟随镜头]",
                    "Pan left / Pan right [水平摇镜]",
                    "Tilt up / Tilt down [垂直仰俯摇镜]",
                    "Orbiting shot / 360-degree arc shot [360度环绕镜头]",
                    "Handheld camera, subtle natural shake [手持摄影自然微抖]",
                    "Documentary style, raw handheld with quick zoom [纪录片抓拍缩放]",
                    "Dolly zoom / Vertigo effect [希区柯克变焦]"
                ], {"default": "Dolly push in [推镜头]"}),
                
                "environment_and_lighting": ("STRING", {"multiline": True, "default": "Soft volumetric ambient light, subtle shadow dynamics."}),
                "audio_and_speech": ("STRING", {"multiline": True, "default": "Audio: Soft rustle of clothing. (S1) whispers: [Japanese] \"じっとしててね\""}),
            },
            "optional": {
                "image": ("IMAGE",),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "synthesize_prompt"
    CATEGORY = "MiniMax_H3"

    def parse_option(self, option_str, language):
        if not option_str or option_str == "none":
            return ""
        match = re.search(r'^(.*?)\s*\[(.*?)\]$', option_str)
        if match:
            en_part, cn_part = match.group(1).strip(), match.group(2).strip()
            return cn_part if language == "CN" else en_part
        return option_str

    def synthesize_prompt(self, subject_and_pose, action_and_movement, language,
                          shot_type, perspective, lens_optics, camera_movement,
                          environment_and_lighting, audio_and_speech, image=None):

        prompt_parts = []
        if subject_and_pose and subject_and_pose.strip():
            prompt_parts.append(subject_and_pose.strip())

        if action_and_movement and action_and_movement.strip():
            prompt_parts.append(action_and_movement.strip())

        raw_options = [shot_type, perspective, lens_optics, camera_movement]
        camera_specs = []
        for opt in raw_options:
            parsed_val = self.parse_option(opt, language)
            if parsed_val:
                camera_specs.append(parsed_val)

        if camera_specs:
            prompt_parts.append(", ".join(camera_specs))

        if environment_and_lighting and environment_and_lighting.strip():
            prompt_parts.append(environment_and_lighting.strip())

        if audio_and_speech and audio_and_speech.strip():
            prompt_parts.append(audio_and_speech.strip())

        final_prompt = ".\n".join(filter(None, prompt_parts))
        if not final_prompt.endswith("."):
            final_prompt += "."

        return (final_prompt,)

NODE_CLASS_MAPPINGS = {
    "MiniMaxH3PromptSynthesizer": MiniMaxH3PromptSynthesizer
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxH3PromptSynthesizer": "MiniMax H3 Prompt Synthesizer"
}