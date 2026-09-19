import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js"; // 导入 ComfyUI 原生 API

app.registerExtension({
    name: "MiniMax.H3.CanvasAnnotator",
    async nodeCreated(node) {
        if (node.comfyClass !== "MiniMax_H3_CanvasAnnotator") return;

        // Hide Native Widgets
        const hideWidget = (w) => {
            if (!w) return;
            w.type = "hidden";
            w.computeSize = () => [0, -4];
            w.draw = () => {};
        };

        hideWidget(node.widgets?.find(w => w.name === "canvas_data"));
        hideWidget(node.widgets?.find(w => w.name === "bg_data"));
        hideWidget(node.widgets?.find(w => w.name === "mode"));

        const modeWidget = node.widgets?.find(w => w.name === "mode");
        const canvasDataWidget = node.widgets?.find(w => w.name === "canvas_data");
        const bgDataWidget = node.widgets?.find(w => w.name === "bg_data");

        // DOM Container Construction
        const container = document.createElement("div");
        container.tabIndex = 0;
        container.style.cssText = "display: flex; flex-direction: column; gap: 6px; padding: 8px; background: #1a1a1e; border-radius: 8px; border: 1px solid #333; box-sizing: border-box; width: 100%; height: 100%; outline: none;";

        const canvas = document.createElement("canvas");
        canvas.style.cssText = "border: 1px solid #444; border-radius: 4px; background: #000; cursor: crosshair; touch-action: none; width: 100%; flex: 1; min-height: 280px;";
        const ctx = canvas.getContext("2d");

        // Offscreen Canvases
        const bgCanvas = document.createElement("canvas");
        const bgCtx = bgCanvas.getContext("2d");
        const drawCanvas = document.createElement("canvas");
        const drawCtx = drawCanvas.getContext("2d");

        bgCanvas.width = drawCanvas.width = 1024;
        bgCanvas.height = drawCanvas.height = 1024;

        bgCtx.fillStyle = "#000000";
        bgCtx.fillRect(0, 0, 1024, 1024);

        // Canvas State & Multi-mode Isolation Data
        let currentMode = "Overlay on Image";
        let uploadedBgImg = null;
        let uploadedBgDataUrl = null;

        let modeData = {
            "Overlay on Image": { strokes: [], sTags: [], aTags: [], frames: [], bgW: 1024, bgH: 1024 },
            "Blank Storyboard": { strokes: [], sTags: [], aTags: [], frames: [], bgW: 1024, bgH: 1024 }
        };

        let isDrawing = false;
        let isPanMode = false;
        let isPanning = false;
        let isEraser = false;
        let currentColor = "#FF0000";
        let brushSize = 6;

        let strokes = [];
        let currentStroke = null;
        let sTags = [];
        let aTags = [];
        let frames = [];
        let history = [];

        let selectedElement = null;
        let clipboardItem = null;
        let activeElement = null;

        let viewScale = 1.0;
        let viewPan = { x: 0, y: 0 };
        let panStart = { x: 0, y: 0 };
        let lastClickTime = 0;

        let isHovered = false;
        container.addEventListener("mouseenter", () => isHovered = true);
        container.addEventListener("mouseleave", () => isHovered = false);

        const colors = [
            { name: "Red", code: "#FF0000" },
            { name: "Yellow", code: "#FFFF00" },
            { name: "Green", code: "#00FF00" },
            { name: "Blue", code: "#0088FF" },
            { name: "Black", code: "#000000" },
            { name: "Purple", code: "#8A2BE2" },
            { name: "White", code: "#FFFFFF" }
        ];

        const storeCurrentModeState = () => {
            modeData[currentMode] = {
                strokes: JSON.parse(JSON.stringify(strokes)),
                sTags: JSON.parse(JSON.stringify(sTags)),
                aTags: JSON.parse(JSON.stringify(aTags)),
                frames: JSON.parse(JSON.stringify(frames)),
                bgW: bgCanvas.width,
                bgH: bgCanvas.height
            };
        };

        const loadModeState = (targetMode) => {
            currentMode = targetMode;
            const data = modeData[targetMode] || { strokes: [], sTags: [], aTags: [], frames: [], bgW: 1024, bgH: 1024 };

            strokes = data.strokes || [];
            sTags = data.sTags || [];
            aTags = data.aTags || [];
            frames = data.frames || [];

            bgCanvas.width = drawCanvas.width = data.bgW || 1024;
            bgCanvas.height = drawCanvas.height = data.bgH || 1024;

            if (currentMode === "Overlay on Image") {
                bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
                if (uploadedBgImg) {
                    bgCtx.drawImage(uploadedBgImg, 0, 0, bgCanvas.width, bgCanvas.height);
                } else {
                    bgCtx.fillStyle = "#000000";
                    bgCtx.fillRect(0, 0, bgCanvas.width, bgCanvas.height);
                }
            } else {
                bgCtx.fillStyle = "#FFFFFF";
                bgCtx.fillRect(0, 0, bgCanvas.width, bgCanvas.height);
            }

            rebuildDrawCanvas();
            render();
        };

        const getNextAvailableId = (prefix, list) => {
            const usedNumbers = new Set();
            const regex = new RegExp(`^${prefix.trim()}\\s*(\\d+)$`);
            list.forEach(item => {
                if (item && item.id) {
                    const match = item.id.trim().match(regex);
                    if (match) usedNumbers.add(parseInt(match[1], 10));
                }
            });
            let nextId = 1;
            while (usedNumbers.has(nextId)) nextId++;
            return prefix.endsWith(" ") ? `${prefix}${nextId}` : `${prefix}${nextId}`;
        };

        const rebuildDrawCanvas = () => {
            drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
            const scaleRatio = drawCanvas.width / 512;

            strokes.forEach(s => {
                if (!s.points || s.points.length < 1) return;
                drawCtx.save();
                drawCtx.beginPath();
                drawCtx.lineCap = "round";
                drawCtx.lineJoin = "round";

                if (s.isEraser) {
                    drawCtx.globalCompositeOperation = "destination-out";
                    drawCtx.lineWidth = s.size * scaleRatio * 2;
                } else {
                    drawCtx.globalCompositeOperation = "source-over";
                    drawCtx.strokeStyle = s.color;
                    drawCtx.lineWidth = s.size * scaleRatio;
                }

                drawCtx.moveTo(s.points[0].x, s.points[0].y);
                for (let i = 1; i < s.points.length; i++) {
                    drawCtx.lineTo(s.points[i].x, s.points[i].y);
                }
                drawCtx.stroke();
                drawCtx.restore();
            });
        };

        const saveState = () => {
            storeCurrentModeState();
            if (history.length >= 25) history.shift();
            history.push({
                mode: currentMode,
                modeDataSnapshot: JSON.parse(JSON.stringify(modeData))
            });
        };

        const undo = () => {
            if (history.length === 0) return;
            const state = history.pop();
            modeData = state.modeDataSnapshot || modeData;
            loadModeState(state.mode || currentMode);
            updateModeButtons();
            syncData();
        };

        const getCompressedBgData = () => {
            const maxDim = 800;
            let w = bgCanvas.width;
            let h = bgCanvas.height;
            if (w > maxDim || h > maxDim) {
                if (w > h) { h = Math.round((h * maxDim) / w); w = maxDim; }
                else { w = Math.round((w * maxDim) / h); h = maxDim; }
            }
            const compCanvas = document.createElement("canvas");
            compCanvas.width = w;
            compCanvas.height = h;
            const compCtx = compCanvas.getContext("2d");
            compCtx.drawImage(bgCanvas, 0, 0, w, h);
            return compCanvas.toDataURL("image/webp", 0.5);
        };

        const syncData = () => {
            storeCurrentModeState();
            if (modeWidget) modeWidget.value = currentMode;

            // 导出纯透明标注图层（不包含 bgCanvas，专用于后端 Alpha 复合）
            const tempCanvas = document.createElement("canvas");
            tempCanvas.width = drawCanvas.width;
            tempCanvas.height = drawCanvas.height;
            const tempCtx = tempCanvas.getContext("2d");

            tempCtx.drawImage(drawCanvas, 0, 0);
            frames.forEach(f => drawFrameBox(tempCtx, f, drawCanvas.width / 512));
            sTags.forEach(tag => drawSTag(tempCtx, tag, drawCanvas.width / 512));
            aTags.forEach(tag => drawATag(tempCtx, tag, drawCanvas.width / 512));

            if (canvasDataWidget) canvasDataWidget.value = tempCanvas.toDataURL("image/png");

            const compressedBg = getCompressedBgData();
            if (bgDataWidget) bgDataWidget.value = compressedBg;

            node.properties = node.properties || {};
            node.properties["canvas_state"] = JSON.stringify({
                currentMode,
                modeData,
                uploadedBgData: uploadedBgDataUrl || null
            });
        };

        const origOnSerialize = node.onSerialize;
        node.onSerialize = function (o) {
            if (origOnSerialize) origOnSerialize.apply(this, arguments);
            storeCurrentModeState();
            o.properties = o.properties || {};
            o.properties["canvas_state"] = JSON.stringify({
                currentMode,
                modeData,
                uploadedBgData: uploadedBgDataUrl || null
            });
        };

        const restoreFromProperties = () => {
            if (node.properties && node.properties["canvas_state"]) {
                try {
                    const state = JSON.parse(node.properties["canvas_state"]);
                    currentMode = state.currentMode || "Overlay on Image";
                    if (state.modeData) {
                        modeData = state.modeData;
                    }
                    uploadedBgDataUrl = state.uploadedBgData || null;

                    if (uploadedBgDataUrl) {
                        const imgBg = new Image();
                        imgBg.crossOrigin = "anonymous";
                        imgBg.onload = () => {
                            uploadedBgImg = imgBg;
                            loadModeState(currentMode);
                            updateModeButtons();
                        };
                        imgBg.src = uploadedBgDataUrl;
                    } else {
                        loadModeState(currentMode);
                        updateModeButtons();
                    }
                } catch (e) {
                    console.error("Canvas restore error:", e);
                }
            }
        };

        const origOnConfigure = node.onConfigure;
        node.onConfigure = function (info) {
            if (origOnConfigure) origOnConfigure.apply(this, arguments);
            setTimeout(restoreFromProperties, 150);
        };

        // 拖拽文件并上传至 ComfyUI/input/ 目录
        container.addEventListener("dragover", (e) => {
            e.preventDefault();
            e.stopPropagation();
        });

        container.addEventListener("drop", async (e) => {
            e.preventDefault();
            e.stopPropagation();

            const files = e.dataTransfer.files;
            if (files && files.length > 0 && files[0].type.startsWith("image/")) {
                const file = files[0];

                try {
                    // 1. 发送图片到 ComfyUI 内部上传 API
                    const formData = new FormData();
                    formData.append("image", file);
                    formData.append("overwrite", "true");

                    const response = await api.fetchApi("/upload/image", {
                        method: "POST",
                        body: formData
                    });

                    if (!response.ok) {
                        throw new Error(`Upload failed with status: ${response.status}`);
                    }

                    const data = await response.json();

                    // 2. 获取存储在 ComfyUI/input/ 目录后的图片地址
                    const imageUrl = api.apiURL(`/view?filename=${encodeURIComponent(data.name)}&type=${data.type || "input"}&subfolder=${encodeURIComponent(data.subfolder || "")}`);

                    // 3. 渲染到 Canvas
                    const img = new Image();
                    img.crossOrigin = "anonymous";
                    img.onload = () => {
                        saveState();
                        uploadedBgImg = img;
                        uploadedBgDataUrl = imageUrl;

                        currentMode = "Overlay on Image";
                        updateModeButtons();

                        bgCanvas.width = drawCanvas.width = img.width;
                        bgCanvas.height = drawCanvas.height = img.height;
                        bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
                        drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
                        bgCtx.drawImage(img, 0, 0);

                        strokes = []; sTags = []; aTags = []; frames = [];
                        viewScale = 1.0; viewPan = { x: 0, y: 0 };
                        render();
                        syncData();
                    };
                    img.src = imageUrl;

                } catch (err) {
                    console.error("[MiniMax H3 Canvas] 上传图片至 input 目录失败:", err);
                }
            }
        });

        canvas.addEventListener("wheel", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
            viewScale = Math.min(Math.max(0.3, viewScale * zoomFactor), 5.0);
            render();
        }, { passive: false });

        const handleGlobalKeyDown = (e) => {
            const isNodeActive = isHovered || container.contains(document.activeElement);
            if (!isNodeActive) return;

            const isCopy = (e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C");
            const isPaste = (e.ctrlKey || e.metaKey) && (e.key === "v" || e.key === "V");
            const isDelete = e.key === "Delete" || e.key === "Backspace";

            if (isCopy || isPaste || isDelete) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
            }

            if (isCopy) {
                if (selectedElement) {
                    if (selectedElement.type === 'A' && aTags[selectedElement.index]) {
                        clipboardItem = { type: 'A', data: JSON.parse(JSON.stringify(aTags[selectedElement.index])) };
                    } else if (selectedElement.type === 'S' && sTags[selectedElement.index]) {
                        clipboardItem = { type: 'S', data: JSON.parse(JSON.stringify(sTags[selectedElement.index])) };
                    }
                }
            } else if (isPaste) {
                if (clipboardItem) {
                    saveState();
                    const newItem = JSON.parse(JSON.stringify(clipboardItem.data));
                    newItem.x += 30;
                    newItem.y += 30;
                    if (clipboardItem.type === 'A') {
                        aTags.push(newItem);
                        selectedElement = { type: 'A', index: aTags.length - 1 };
                    } else if (clipboardItem.type === 'S') {
                        sTags.push(newItem);
                        selectedElement = { type: 'S', index: sTags.length - 1 };
                    }
                    render(); syncData();
                }
            } else if (isDelete) {
                if (selectedElement) {
                    saveState();
                    if (selectedElement.type === 'A') aTags.splice(selectedElement.index, 1);
                    else if (selectedElement.type === 'S') sTags.splice(selectedElement.index, 1);
                    selectedElement = null;
                    render(); syncData();
                }
            }
        };

        window.addEventListener("keydown", handleGlobalKeyDown, true);

        const origOnRemoved = node.onRemoved;
        node.onRemoved = function() {
            window.removeEventListener("keydown", handleGlobalKeyDown, true);
            if (origOnRemoved) origOnRemoved.apply(this, arguments);
        };

        const drawSTag = (targetCtx, tag, scale = 1.0) => {
            const size = 32 * scale;
            targetCtx.save();
            targetCtx.translate(tag.x, tag.y);

            targetCtx.beginPath();
            targetCtx.moveTo(-size / 2, -size / 2);
            targetCtx.lineTo(size / 2, -size / 2);
            targetCtx.lineTo(0, size / 2);
            targetCtx.closePath();

            targetCtx.fillStyle = "#8A2BE2";
            targetCtx.fill();
            targetCtx.strokeStyle = tag.isSelected ? "#00FFFF" : "#FFFFFF";
            targetCtx.lineWidth = (tag.isSelected ? 3 : 2) * scale;
            targetCtx.stroke();

            targetCtx.fillStyle = "#FFFFFF";
            targetCtx.font = `bold ${12 * scale}px sans-serif`;
            targetCtx.textAlign = "center";
            targetCtx.textBaseline = "middle";
            targetCtx.fillText(tag.id, 0, -size / 6);

            targetCtx.restore();
        };

        const drawATag = (targetCtx, tag, scale = 1.0) => {
            const size = 32 * scale;
            targetCtx.save();
            targetCtx.translate(tag.x, tag.y);

            targetCtx.beginPath();
            targetCtx.moveTo(0, -size / 2);
            targetCtx.lineTo(size / 2, size / 2);
            targetCtx.lineTo(-size / 2, size / 2);
            targetCtx.closePath();

            targetCtx.fillStyle = "#8A2BE2";
            targetCtx.fill();
            targetCtx.strokeStyle = tag.isSelected ? "#00FFFF" : "#FFFFFF";
            targetCtx.lineWidth = (tag.isSelected ? 3 : 2) * scale;
            targetCtx.stroke();

            targetCtx.fillStyle = "#FFFFFF";
            targetCtx.font = `bold ${12 * scale}px sans-serif`;
            targetCtx.textAlign = "center";
            targetCtx.textBaseline = "middle";
            targetCtx.fillText(tag.id, 0, size / 6);

            targetCtx.restore();
        };

        const drawFrameBox = (targetCtx, frame, scale = 1.0) => {
            targetCtx.save();
            targetCtx.strokeStyle = "#FFD700";
            targetCtx.lineWidth = 3 * scale;
            targetCtx.setLineDash([8 * scale, 4 * scale]);
            targetCtx.strokeRect(frame.x, frame.y, frame.w, frame.h);

            targetCtx.fillStyle = "#FFD700";
            targetCtx.fillRect(frame.x, frame.y - 28 * scale, 95 * scale, 28 * scale);
            targetCtx.fillStyle = "#000000";
            targetCtx.font = `bold ${13 * scale}px sans-serif`;
            targetCtx.textAlign = "center";
            targetCtx.textBaseline = "middle";
            targetCtx.fillText(frame.id, frame.x + 47.5 * scale, frame.y - 14 * scale);

            const handleSize = 16 * scale;
            targetCtx.fillStyle = "#FFD700";
            targetCtx.fillRect(frame.x + frame.w - handleSize, frame.y + frame.h - handleSize, handleSize, handleSize);

            targetCtx.restore();
        };

        const render = () => {
            const rect = canvas.getBoundingClientRect();
            if (canvas.width !== rect.width || canvas.height !== rect.height) {
                canvas.width = rect.width || 512;
                canvas.height = rect.height || 340;
            }

            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.save();
            ctx.translate(viewPan.x, viewPan.y);
            ctx.scale(viewScale, viewScale);

            const aspect = bgCanvas.width / bgCanvas.height;
            let dw = canvas.width;
            let dh = canvas.height;
            if (aspect > 1) dh = canvas.width / aspect;
            else dw = canvas.height * aspect;

            const dx = (canvas.width - dw) / 2;
            const dy = (canvas.height - dh) / 2;

            ctx.drawImage(bgCanvas, dx, dy, dw, dh);
            ctx.drawImage(drawCanvas, dx, dy, dw, dh);

            const renderScale = dw / bgCanvas.width;

            frames.forEach(f => {
                drawFrameBox(ctx, {
                    id: f.id,
                    x: dx + f.x * renderScale,
                    y: dy + f.y * renderScale,
                    w: f.w * renderScale,
                    h: f.h * renderScale
                }, 1.0);
            });

            sTags.forEach(tag => {
                drawSTag(ctx, {
                    id: tag.id,
                    x: dx + tag.x * renderScale,
                    y: dy + tag.y * renderScale,
                    isSelected: selectedElement?.type === 'S' && selectedElement.index === sTags.indexOf(tag)
                }, 1.0);
            });

            aTags.forEach(tag => {
                drawATag(ctx, {
                    id: tag.id,
                    x: dx + tag.x * renderScale,
                    y: dy + tag.y * renderScale,
                    isSelected: selectedElement?.type === 'A' && selectedElement.index === aTags.indexOf(tag)
                }, 1.0);
            });

            if (currentMode === "Blank Storyboard") {
                const handleSize = 18;
                ctx.fillStyle = "#2e5b88";
                ctx.strokeStyle = "#FFFFFF";
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.rect(dx + dw - handleSize, dy + dh - handleSize, handleSize, handleSize);
                ctx.fill();
                ctx.stroke();
            }

            ctx.restore();
        };

        const getCanvasPos = (e) => {
            const rect = canvas.getBoundingClientRect();
            const clientX = e.clientX - rect.left;
            const clientY = e.clientY - rect.top;

            const aspect = bgCanvas.width / bgCanvas.height;
            let dw = canvas.width;
            let dh = canvas.height;
            if (aspect > 1) dh = canvas.width / aspect;
            else dw = canvas.height * aspect;

            const dx = (canvas.width - dw) / 2;
            const dy = (canvas.height - dh) / 2;

            const vx = (clientX * (canvas.width / rect.width) - viewPan.x) / viewScale;
            const vy = (clientY * (canvas.height / rect.height) - viewPan.y) / viewScale;

            return {
                x: ((vx - dx) / dw) * drawCanvas.width,
                y: ((vy - dy) / dh) * drawCanvas.height,
                vx, vy, dx, dy, dw, dh
            };
        };

        const hitTestControls = (pos) => {
            for (let i = sTags.length - 1; i >= 0; i--) {
                if (Math.hypot(pos.x - sTags[i].x, pos.y - sTags[i].y) < 28) {
                    return { type: 'S_move', index: i, offsetX: pos.x - sTags[i].x, offsetY: pos.y - sTags[i].y };
                }
            }
            for (let i = aTags.length - 1; i >= 0; i--) {
                if (Math.hypot(pos.x - aTags[i].x, pos.y - aTags[i].y) < 28) {
                    return { type: 'A_move', index: i, offsetX: pos.x - aTags[i].x, offsetY: pos.y - aTags[i].y };
                }
            }

            for (let i = frames.length - 1; i >= 0; i--) {
                const f = frames[i];
                if (Math.abs(pos.x - (f.x + f.w)) < 30 && Math.abs(pos.y - (f.y + f.h)) < 30) {
                    return { type: 'frame_resize', index: i, startW: f.w, startH: f.h, startX: pos.x, startY: pos.y };
                }
                if (pos.x >= f.x - 10 && pos.x <= f.x + 105 && pos.y >= f.y - 35 && pos.y <= f.y + 10) {
                    return { type: 'frame_move', index: i, offsetX: pos.x - f.x, offsetY: pos.y - f.y };
                }
            }

            if (currentMode === "Blank Storyboard") {
                if (Math.abs(pos.vx - (pos.dx + pos.dw)) < 22 && Math.abs(pos.vy - (pos.dy + pos.dh)) < 22) {
                    return { type: 'canvas_resize', startW: bgCanvas.width, startH: bgCanvas.height, startX: pos.vx, startY: pos.vy };
                }
            }

            return null;
        };

        canvas.addEventListener("pointerdown", (e) => {
            container.focus();
            const now = Date.now();
            const isDoubleClick = (now - lastClickTime < 300);
            lastClickTime = now;

            const pos = getCanvasPos(e);
            const hit = hitTestControls(pos);

            if (isEraser && isDoubleClick && hit) {
                saveState();
                if (hit.type === 'frame_move' || hit.type === 'frame_resize') frames.splice(hit.index, 1);
                else if (hit.type === 'S_move') sTags.splice(hit.index, 1);
                else if (hit.type === 'A_move') aTags.splice(hit.index, 1);
                selectedElement = null;
                render(); syncData();
                return;
            }

            if (hit) {
                saveState();
                activeElement = hit;
                canvas.setPointerCapture(e.pointerId);

                if (hit.type === 'A_move') selectedElement = { type: 'A', index: hit.index };
                else if (hit.type === 'S_move') selectedElement = { type: 'S', index: hit.index };
                else selectedElement = null;

                canvas.style.cursor = hit.type.includes('resize') ? "nwse-resize" : "move";
                render();
                return;
            }

            if (isPanMode || e.button === 1 || e.altKey) {
                isPanning = true;
                panStart = { x: e.clientX - viewPan.x, y: e.clientY - viewPan.y };
                canvas.style.cursor = "grabbing";
                return;
            }

            selectedElement = null;

            saveState();
            isDrawing = true;
            currentStroke = {
                color: currentColor,
                size: brushSize,
                isEraser: isEraser,
                points: [{ x: pos.x, y: pos.y }]
            };
            strokes.push(currentStroke);
            rebuildDrawCanvas();
            render();
        });

        canvas.addEventListener("pointermove", (e) => {
            if (isPanning) {
                viewPan.x = e.clientX - panStart.x;
                viewPan.y = e.clientY - panStart.y;
                render();
                return;
            }

            const pos = getCanvasPos(e);

            if (activeElement) {
                if (activeElement.type === 'canvas_resize') {
                    const scaleFactor = drawCanvas.width / pos.dw;
                    const newW = Math.max(300, activeElement.startW + (pos.vx - activeElement.startX) * scaleFactor);
                    const newH = Math.max(300, activeElement.startH + (pos.vy - activeElement.startY) * scaleFactor);

                    bgCanvas.width = drawCanvas.width = Math.round(newW);
                    bgCanvas.height = drawCanvas.height = Math.round(newH);

                    bgCtx.fillStyle = "#FFFFFF"; bgCtx.fillRect(0, 0, bgCanvas.width, bgCanvas.height);
                    rebuildDrawCanvas();
                } else if (activeElement.type === 'S_move') {
                    sTags[activeElement.index].x = pos.x - activeElement.offsetX;
                    sTags[activeElement.index].y = pos.y - activeElement.offsetY;
                } else if (activeElement.type === 'A_move') {
                    aTags[activeElement.index].x = pos.x - activeElement.offsetX;
                    aTags[activeElement.index].y = pos.y - activeElement.offsetY;
                } else if (activeElement.type === 'frame_move') {
                    frames[activeElement.index].x = pos.x - activeElement.offsetX;
                    frames[activeElement.index].y = pos.y - activeElement.offsetY;
                } else if (activeElement.type === 'frame_resize') {
                    frames[activeElement.index].w = Math.max(100, activeElement.startW + (pos.x - activeElement.startX));
                    frames[activeElement.index].h = Math.max(80, activeElement.startH + (pos.y - activeElement.startY));
                }
                render();
                return;
            }

            if (!isDrawing || !currentStroke) return;
            currentStroke.points.push({ x: pos.x, y: pos.y });
            rebuildDrawCanvas();
            render();
        });

        const stopDrawing = (e) => {
            if (activeElement) {
                if (e.pointerId) canvas.releasePointerCapture(e.pointerId);
                activeElement = null;
                canvas.style.cursor = isPanMode ? "grab" : "crosshair";
                syncData();
            }
            if (isDrawing) {
                isDrawing = false;
                currentStroke = null;
                syncData();
            }
            if (isPanning) {
                isPanning = false;
                canvas.style.cursor = isPanMode ? "grab" : "crosshair";
            }
        };
        canvas.addEventListener("pointerup", stopDrawing);
        canvas.addEventListener("pointerleave", stopDrawing);

        const modeBar = document.createElement("div");
        modeBar.style.cssText = "display: flex; gap: 4px; width: 100%;";

        const btnOverlay = document.createElement("button");
        btnOverlay.textContent = "🖼️ Overlay Image";

        const btnBlankMode = document.createElement("button");
        btnBlankMode.textContent = "📄 Blank Storyboard";

        const updateModeButtons = () => {
            if (currentMode === "Overlay on Image") {
                btnOverlay.style.cssText = "flex: 1; padding: 5px; background: #2e5b88; color: #fff; border: 1px solid #4a7bb0; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: bold;";
                btnBlankMode.style.cssText = "flex: 1; padding: 5px; background: #333; color: #ccc; border: 1px solid #555; border-radius: 4px; cursor: pointer; font-size: 11px;";
            } else {
                btnBlankMode.style.cssText = "flex: 1; padding: 5px; background: #2e5b88; color: #fff; border: 1px solid #4a7bb0; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: bold;";
                btnOverlay.style.cssText = "flex: 1; padding: 5px; background: #333; color: #ccc; border: 1px solid #555; border-radius: 4px; cursor: pointer; font-size: 11px;";
            }
        };

        btnOverlay.onclick = () => {
            if (currentMode === "Overlay on Image") return;
            saveState();
            storeCurrentModeState();
            loadModeState("Overlay on Image");
            updateModeButtons();
            syncData();
        };

        btnBlankMode.onclick = () => {
            if (currentMode === "Blank Storyboard") return;
            saveState();
            storeCurrentModeState();
            loadModeState("Blank Storyboard");
            updateModeButtons();
            syncData();
        };

        updateModeButtons();
        modeBar.appendChild(btnOverlay);
        modeBar.appendChild(btnBlankMode);

        const toolbarTop = document.createElement("div");
        toolbarTop.style.cssText = "display: flex; gap: 4px; align-items: center; justify-content: space-between;";

        const palette = document.createElement("div");
        palette.style.cssText = "display: flex; gap: 4px; align-items: center;";
        colors.forEach(c => {
            const btn = document.createElement("div");
            btn.style.cssText = `width: 16px; height: 16px; border-radius: 50%; background: ${c.code}; cursor: pointer; border: 2px solid ${c.code === currentColor && !isEraser ? '#FFF' : 'transparent'};`;
            btn.title = c.name;
            btn.onclick = () => {
                isEraser = false; isPanMode = false; currentColor = c.code;
                canvas.style.cursor = "crosshair";
                Array.from(palette.children).forEach(child => child.style.borderColor = 'transparent');
                btn.style.borderColor = '#FFF';
                btnPan.style.background = btnEraser.style.background = "#333";
            };
            palette.appendChild(btn);
        });

        const slider = document.createElement("input");
        slider.type = "range"; slider.min = "2"; slider.max = "30"; slider.value = brushSize;
        slider.style.width = "40px";
        slider.oninput = (e) => brushSize = e.target.value;

        const btnPan = document.createElement("button");
        btnPan.textContent = "✋ Pan";
        btnPan.style.cssText = "padding: 3px 5px; background: #333; color: #fff; border: 1px solid #555; border-radius: 3px; cursor: pointer; font-size: 11px;";
        btnPan.onclick = () => {
            isPanMode = !isPanMode;
            btnPan.style.background = isPanMode ? "#2e5b88" : "#333";
            canvas.style.cursor = isPanMode ? "grab" : "crosshair";
        };

        const btnAddSTag = document.createElement("button");
        btnAddSTag.textContent = "➕ S Tag";
        btnAddSTag.style.cssText = "padding: 3px 5px; background: #333; color: #fff; border: 1px solid #555; border-radius: 3px; cursor: pointer; font-size: 11px;";
        btnAddSTag.onclick = () => {
            saveState();
            const tagId = getNextAvailableId("S", sTags);
            sTags.push({ id: tagId, x: bgCanvas.width / 2, y: bgCanvas.height / 2 });
            render(); syncData();
        };

        const btnAddATag = document.createElement("button");
        btnAddATag.textContent = "▲ A Tag";
        btnAddATag.style.cssText = "padding: 3px 5px; background: #8A2BE2; color: #fff; border: 1px solid #a040f0; border-radius: 3px; cursor: pointer; font-size: 11px; font-weight: bold;";
        btnAddATag.onclick = () => {
            saveState();
            const tagId = getNextAvailableId("A", aTags);
            aTags.push({ id: tagId, x: bgCanvas.width / 2, y: bgCanvas.height / 2 });
            render(); syncData();
        };

        const toolbarBottom = document.createElement("div");
        toolbarBottom.style.cssText = "display: flex; gap: 4px; align-items: center; justify-content: space-between;";

        const btnAddFrame = document.createElement("button");
        btnAddFrame.textContent = "➕ Frame";
        btnAddFrame.style.cssText = "padding: 3px 5px; background: #333; color: #fff; border: 1px solid #555; border-radius: 3px; cursor: pointer; font-size: 11px;";
        btnAddFrame.onclick = () => {
            saveState();
            const frameId = getNextAvailableId("Shot ", frames);
            const fw = bgCanvas.width * 0.7;
            const fh = bgCanvas.height * 0.22;
            const fy = 50 + (frames.length) * (fh + 30);
            frames.push({ id: frameId, x: (bgCanvas.width - fw) / 2, y: fy, w: fw, h: fh });
            render(); syncData();
        };

        const btnEraser = document.createElement("button");
        btnEraser.textContent = "🧹 Eraser";
        btnEraser.style.cssText = "padding: 3px 5px; background: #333; color: #fff; border: 1px solid #555; border-radius: 3px; cursor: pointer; font-size: 11px;";
        btnEraser.onclick = () => {
            isEraser = !isEraser; isPanMode = false;
            btnEraser.style.background = isEraser ? "#8B0000" : "#333";
            btnPan.style.background = "#333";
            canvas.style.cursor = "crosshair";
        };

        const btnUndo = document.createElement("button");
        btnUndo.textContent = "↩️ Undo";
        btnUndo.style.cssText = "padding: 3px 5px; background: #333; color: #fff; border: 1px solid #555; border-radius: 3px; cursor: pointer; font-size: 11px;";
        btnUndo.onclick = undo;

        const btnClear = document.createElement("button");
        btnClear.textContent = "🗑️ Clear";
        btnClear.style.cssText = "padding: 3px 5px; background: #333; color: #fff; border: 1px solid #555; border-radius: 3px; cursor: pointer; font-size: 11px;";
        btnClear.onclick = () => {
            saveState();
            strokes = []; sTags = []; aTags = []; frames = [];
            rebuildDrawCanvas();
            render(); syncData();
        };

        toolbarTop.appendChild(palette);
        toolbarTop.appendChild(slider);
        toolbarTop.appendChild(btnPan);
        toolbarTop.appendChild(btnAddSTag);
        toolbarTop.appendChild(btnAddATag);

        toolbarBottom.appendChild(btnAddFrame);
        toolbarBottom.appendChild(btnEraser);
        toolbarBottom.appendChild(btnUndo);
        toolbarBottom.appendChild(btnClear);

        container.appendChild(modeBar);
        container.appendChild(canvas);
        container.appendChild(toolbarTop);
        container.appendChild(toolbarBottom);

        node.addDOMWidget("canvas_widget", "Canvas", container);

        node.onResize = function () { render(); };
        node.size = [430, 570];
        setTimeout(render, 100);
    }
});