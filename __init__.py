import os

# 动态判断静态文件目录：兼容 JS 文件存放在根目录或 web 目录
current_dir = os.path.dirname(os.path.realpath(__file__))
if os.path.exists(os.path.join(current_dir, "web")):
    WEB_DIRECTORY = "./web"
else:
    WEB_DIRECTORY = "."

from .minimax_h3_template_node import (
    NODE_CLASS_MAPPINGS as TEMPLATE_CLASS,
    NODE_DISPLAY_NAME_MAPPINGS as TEMPLATE_DISPLAY
)
from .minimax_h3_annotator_node import (
    NODE_CLASS_MAPPINGS as ANNOTATOR_CLASS,
    NODE_DISPLAY_NAME_MAPPINGS as ANNOTATOR_DISPLAY
)

NODE_CLASS_MAPPINGS = {**TEMPLATE_CLASS, **ANNOTATOR_CLASS}
NODE_DISPLAY_NAME_MAPPINGS = {**TEMPLATE_DISPLAY, **ANNOTATOR_DISPLAY}

__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS', 'WEB_DIRECTORY']