import os
import re
import socket
import ipaddress
import uuid
import urllib.parse
import aiohttp
from aiohttp import web
from server import PromptServer
import folder_paths

# =====================================================================
# 🛡️ 安全防御与图片验证 API
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
    return filename if filename else f"download_{uuid.uuid4().hex[:8]}"

def verify_image_dna(file_path):
    try:
        if not os.path.exists(file_path):
            return False
        with open(file_path, "rb") as f:
            header = f.read(12)
        if header.startswith(b'\x89PNG\r\n\x1a\n'): return "png"
        if header.startswith(b'\xff\xd8\xff'): return "jpeg"
        if header.startswith(b'GIF87a') or header.startswith(b'GIF89a'): return "gif"
        if header.startswith(b'RIFF') and b'WEBP' in header: return "webp"
        return False
    except Exception:
        return False

# 拖拽跨域图片网络安全下载接口
@PromptServer.instance.routes.post("/anima/upload_url")
async def upload_url_route(request):
    temp_target_path = None
    try:
        data = await request.json()
        url = data.get("url")
        if not url:
            return web.json_response({"success": False, "error": "未接收到有效的图片URL"}, status=400)
            
        parsed_url = urllib.parse.urlparse(url)
        if parsed_url.scheme not in ("http", "https") or not parsed_url.hostname:
            return web.json_response({"success": False, "error": "安全防御：非法协议或主机名"}, status=403)

        is_safe, safe_ips = verify_and_get_safe_ips(parsed_url.hostname)
        if not is_safe:
            return web.json_response({"success": False, "error": "安全防御：禁止访问内网地址"}, status=403)
            
        input_dir = folder_paths.get_input_directory()
        
        # 安全清洗文件名
        raw_name = os.path.basename(parsed_url.path) or f"anima_drag_{uuid.uuid4().hex[:8]}.png"
        safe_name = sanitize_filename(raw_name)
        temp_target_path = os.path.join(input_dir, f"{safe_name}_{uuid.uuid4().hex[:4]}.downloading")

        # 使用固定 IP + Host Header，彻底消除 DNS Rebinding (TOCTOU) 风险
        target_ip = safe_ips[0]
        direct_url = parsed_url._replace(netloc=target_ip).geturl()
        headers = {
            "Host": parsed_url.hostname,
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }

        async with aiohttp.ClientSession() as session:
            async with session.get(direct_url, headers=headers, timeout=10, ssl=False) as response:
                if response.status != 200:
                    return web.json_response({"success": False, "error": f"HTTP {response.status}"}, status=400)
                
                with open(temp_target_path, "wb") as f:
                    async for chunk in response.content.iter_chunked(8192):
                        f.write(chunk)

        actual_type = verify_image_dna(temp_target_path)
        if not actual_type:
            if os.path.exists(temp_target_path): 
                os.remove(temp_target_path)
            return web.json_response({"success": False, "error": "安全拦截：非法或损坏的图片格式！"}, status=400)

        final_filename = f"{os.path.splitext(safe_name)[0]}.{actual_type}"
        final_target_path = os.path.join(input_dir, final_filename)
        
        # 使用 os.replace 解决 Windows 环境下同名文件已存在的报错问题
        os.replace(temp_target_path, final_target_path)
        return web.json_response({"success": True, "name": final_filename})

    except Exception as e:
        if temp_target_path and os.path.exists(temp_target_path): 
            os.remove(temp_target_path)
        return web.json_response({"success": False, "error": str(e)}, status=500)

# =====================================================================
# 🧩 MiniMax H3 提示词合成节点
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
                
                # 1. 景别 (带中文标注)
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
                
                # 2. 视角 (带中文标注)
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
                
                # 3. 光学与镜头质感 (带中文标注)
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
                
                # 4. 运镜 (带中文标注)
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
                    "Dolly zoom / Vertigo effect [希区克克变焦]"
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
        """解析带有 [中文标注] 的下拉框文本"""
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

        # 解析 4 大维度选项
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