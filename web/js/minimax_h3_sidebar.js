import { app } from "/scripts/app.js";

// 全局保存分屏窗口句柄
let splitWindow = null;

// Toast 消息提示框
function showToast(message) {
    let toast = document.getElementById('minimax-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'minimax-toast';
        toast.style = "position: fixed; bottom: 20px; right: 20px; background: rgba(30, 41, 59, 0.95); color: #fff; padding: 10px 18px; border-radius: 6px; z-index: 100000; transition: opacity 0.3s, transform 0.3s; font-size: 13px; font-weight: 500; box-shadow: 0 4px 12px rgba(0,0,0,0.4); border: 1px solid #334155;";
        document.body.appendChild(toast);
    }
    toast.innerText = message;
    toast.style.opacity = '1';
    setTimeout(() => { toast.style.opacity = '0'; }, 2300);
}

// 打开或跳转同一右侧独立分屏窗口
function openRightWindow(url) {
    const screenWidth = window.screen.availWidth;
    const screenHeight = window.screen.availHeight;
    const winWidth = Math.floor(screenWidth * 0.45); // 占用屏幕右侧 45% 宽度
    const winHeight = screenHeight;
    const left = screenWidth - winWidth;
    const top = 0;

    const windowFeatures = `width=${winWidth},height=${winHeight},left=${left},top=${top},resizable=yes,scrollbars=yes,location=yes,status=yes`;
    
    // 使用固定的窗口标识名 "Anima_Split_Window"，确保在同一窗口内直接跳转切换
    splitWindow = window.open(url, "Anima_Split_Window", windowFeatures);
    
    if (splitWindow) {
        splitWindow.focus();
    }
}

app.registerExtension({
    name: "MiniMaxH3.Sidebar",
    
    async setup() {
        // 🌟 1. 鼠标悬停屏幕右侧上半区（右边缘 30px 且 Y 轴在屏高上半部分），自动唤起子窗口
        window.addEventListener("mousemove", (e) => {
            const isRightEdge = e.clientX >= window.innerWidth - 30;
            const isUpperHalf = e.clientY <= (window.innerHeight / 2);

            if (isRightEdge && isUpperHalf) {
                if (splitWindow && !splitWindow.closed) {
                    splitWindow.focus();
                }
            }
        });

        // 🛡️ 2. 全局监听图片拖拽，安全上传至后端并填充节点
        window.addEventListener("drop", async (event) => {
            let url = event.dataTransfer.getData("text/plain") || event.dataTransfer.getData("text/uri-list");
            const html = event.dataTransfer.getData("text/html");
            
            if (html && (!url || !url.startsWith("http"))) {
                const match = html.match(/src=["'](.*?)["']/);
                if (match) {
                    url = match[1];
                }
            }
            
            if (!url || !url.startsWith("http")) return;

            const canvas = app.canvas;
            if (!canvas) return;

            const pos = canvas.convertEventToCanvasOffset({ clientX: event.clientX, clientY: event.clientY });
            const node = canvas.getNodeOnPos(pos[0], pos[1]);
            
            if (!node?.widgets) return;

            const imageWidget = node.widgets.find(w => w.name === "image");
            if (!imageWidget) return;

            event.preventDefault();
            event.stopPropagation();
            
            const oldVal = imageWidget.value;
            imageWidget.value = "⚡ 正在通过后端安全下载图片...";
            
            try {
                const response = await fetch("/anima/upload_url", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ url })
                });
                const result = await response.json();
                
                if (result.name) {
                    imageWidget.value = result.name;
                    if (imageWidget.callback) {
                        imageWidget.callback(result.name);
                    }
                    node.setSize(node.computeSize());
                    app.graph.setDirtyCanvas(true, true);
                    showToast("✅ 云端图片已成功接入节点！");
                } else {
                    imageWidget.value = oldVal;
                    showToast(`❌ ${result.error || "下载失败"}`);
                }
            } catch (err) {
                console.error(err);
                imageWidget.value = oldVal;
                showToast("❌ 无法连接到 ComfyUI 后端下载服务！");
            }
        }, false);
    },

    async nodeCreated(node) {
        if (node.comfyClass === "MiniMaxH3PromptSynthesizer") {
            
            // 1. Danbooru 热门按钮
            node.addWidget(
                "button", 
                "🌐 打开 Danbooru 热门 (Hot)", 
                null, 
                () => {
                    openRightWindow("https://danbooru.donmai.us/posts?tags=order%3Arank");
                }
            );

            // 2. E-Hentai AI 标签页按钮
            node.addWidget(
                "button", 
                "🔥 打开 E-Hentai (AI Generated)", 
                null, 
                () => {
                    openRightWindow("https://e-hentai.org/?f_search=ai+generated");
                }
            );
        }
    }
});