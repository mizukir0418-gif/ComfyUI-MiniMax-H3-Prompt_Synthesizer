import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

app.registerExtension({
    name: "MiniMax.H3.CanvasAnnotator",
    async nodeCreated(node) {
        if (node.comfyClass !== "MiniMax_H3_CanvasAnnotator") return;

        // 1. Hide native ComfyUI widgets & keep static value empty to prevent LocalStorage 5MB crash
        const hideWidget = (w) => {
            if (!w) return;
            w.type = "hidden";
            w.hidden = true;
            w.value = "";
            w.computeSize = () => [0, -4];
            w.draw = () => {};
        };
        const canvasDataWidget = node.widgets?.find(w => w.name === "canvas_data");
        const bgDataWidget = node.widgets?.find(w => w.name === "bg_data");
        hideWidget(canvasDataWidget);
        hideWidget(bgDataWidget);

        // Main DOM container
        const container = document.createElement("div");
        container.tabIndex = 0;
        container.style.cssText = "display: flex; flex-direction: column; gap: 5px; padding: 6px; background: #18181b; border-radius: 8px; border: 1px solid #3f3f46; box-sizing: border-box; width: 100%; height: 100%; outline: none; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; user-select: none; position: relative;";

        const canvas = document.createElement("canvas");
        canvas.style.cssText = "border: 1px solid #3f3f46; border-radius: 4px; background: #09090b; cursor: crosshair; touch-action: none; width: 100%; flex: 1; min-height: 320px;";
        const ctx = canvas.getContext("2d");

        // 3-Layer Strict Isolation Canvases
        const bgCanvas = document.createElement("canvas");
        const bgCtx = bgCanvas.getContext("2d");

        const stickerCanvas = document.createElement("canvas");
        const stickerCtx = stickerCanvas.getContext("2d");

        const drawCanvas = document.createElement("canvas");
        const drawCtx = drawCanvas.getContext("2d");

        const CHROMA_GREEN = "#00B140";
        bgCanvas.width = stickerCanvas.width = drawCanvas.width = 1024;
        bgCanvas.height = stickerCanvas.height = drawCanvas.height = 1024;
        bgCtx.fillStyle = CHROMA_GREEN;
        bgCtx.fillRect(0, 0, 1024, 1024);

        let uploadedBgImg = null;
        let uploadedBgFilename = null;
        let currentRatioLabel = "1:1 (Square) [1024×1024]";

        let viewport = { x: 0, y: 0, w: 1024, h: 1024, origRatio: 1.0 };
        let stagePadding = { top: 0, right: 0, bottom: 0, left: 0 };

        let currentTool = "brush"; // move, brush, eraser, line, arrow, rect, ellipse, text
        let currentColor = "#FF0000";
        let brushSize = 6;
        let isFilled = false;

        let isDrawing = false;
        let isPanMode = false;
        let isPanning = false;
        let currentShape = null;

        let elements = [];
        let stickers = [];
        let sTags = [];
        let aTags = [];
        let frames = [];

        let undoStack = [];
        let redoStack = [];

        let selectedElement = null;
        let activeControl = null;
        let clipboardItem = null;

        let viewScale = 1.0;
        let viewPan = { x: 0, y: 0 };
        let panStart = { x: 0, y: 0 };
        let isHovered = false;

        container.addEventListener("mouseenter", () => isHovered = true);
        container.addEventListener("mouseleave", () => isHovered = false);

        const winColors = [
            "#000000", "#7F7F7F", "#880015", "#ED1C24", "#FF7F27",
            "#FFF200", "#22B14C", "#00A2E8", "#3F48CC", "#A349A4", "#FFFFFF"
        ];

        const STANDARD_RATIOS = [
            { name: "1:1 (Square)", ratio: 1.0 },
            { name: "2:3 (Portrait Photo)", ratio: 2 / 3 },
            { name: "3:2 (Photo)", ratio: 3 / 2 },
            { name: "3:4 (Portrait Standard)", ratio: 3 / 4 },
            { name: "4:3 (Standard)", ratio: 4 / 3 },
            { name: "9:16 (Portrait Widescreen)", ratio: 9 / 16 },
            { name: "16:9 (Widescreen)", ratio: 16 / 9 },
            { name: "21:9 (Ultrawide)", ratio: 21 / 9 }
        ];

        const computeAspectRatio = (w, h) => {
            const current = w / h;
            let closest = STANDARD_RATIOS[0];
            let minDiff = Math.abs(current - closest.ratio);
            for (let i = 1; i < STANDARD_RATIOS.length; i++) {
                const diff = Math.abs(current - STANDARD_RATIOS[i].ratio);
                if (diff < minDiff) { minDiff = diff; closest = STANDARD_RATIOS[i]; }
            }
            return `${closest.name} [${w}×${h}]`;
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

        // Shift all coordinates when Top or Left green margin changes (Zero Coordinate Drift)
        const shiftAllCoordinates = (dx, dy) => {
            if (dx === 0 && dy === 0) return;
            elements.forEach(el => {
                if (el.points) el.points.forEach(p => { p.x += dx; p.y += dy; });
                if (el.x !== undefined) el.x += dx;
                if (el.y !== undefined) el.y += dy;
                if (el.x1 !== undefined) { el.x1 += dx; el.x2 += dx; el.y1 += dy; el.y2 += dy; }
                if (el.cx !== undefined) { el.cx += dx; el.cy += dy; }
            });
            stickers.forEach(st => { st.x += dx; st.y += dy; });
            sTags.forEach(t => { t.x += dx; t.y += dy; });
            aTags.forEach(t => { t.x += dx; t.y += dy; });
            frames.forEach(f => { f.x += dx; f.y += dy; });
        };

        const updateStageCanvases = () => {
            const totalW = Math.round(viewport.w + stagePadding.left + stagePadding.right);
            const totalH = Math.round(viewport.h + stagePadding.top + stagePadding.bottom);

            viewport.x = stagePadding.left;
            viewport.y = stagePadding.top;

            bgCanvas.width = stickerCanvas.width = drawCanvas.width = totalW;
            bgCanvas.height = stickerCanvas.height = drawCanvas.height = totalH;

            bgCtx.fillStyle = CHROMA_GREEN;
            bgCtx.fillRect(0, 0, totalW, totalH);

            if (uploadedBgImg) {
                bgCtx.drawImage(uploadedBgImg, viewport.x, viewport.y, viewport.w, viewport.h);
            }

            rebuildStickerCanvas();
            rebuildDrawCanvas();
            render();
            saveLightweightState();
        };

        const removeBackgroundImage = () => {
            saveState();
            uploadedBgImg = null;
            uploadedBgFilename = null;
            viewport = { x: 0, y: 0, w: 1024, h: 1024, origRatio: 1.0 };
            stagePadding = { top: 0, right: 0, bottom: 0, left: 0 };
            currentRatioLabel = "1:1 (Square) [1024×1024]";

            elements = []; stickers = []; sTags = []; aTags = []; frames = [];
            selectedElement = null;
            viewScale = 1.0; viewPan = { x: 0, y: 0 };
            updateStageCanvases();
            updateLayersList();
        };

        container.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); });
        container.addEventListener("drop", async (e) => {
            e.preventDefault(); e.stopPropagation();
            const files = e.dataTransfer.files;
            if (files && files.length > 0 && files[0].type.startsWith("image/")) {
                const file = files[0];
                try {
                    const formData = new FormData();
                    formData.append("image", file);
                    formData.append("overwrite", "true");

                    const response = await api.fetchApi("/upload/image", { method: "POST", body: formData });
                    if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
                    const data = await response.json();
                    const imageUrl = api.apiURL(`/view?filename=${encodeURIComponent(data.name)}&type=${data.type || "input"}&subfolder=${encodeURIComponent(data.subfolder || "")}`);
                    
                    const img = new Image();
                    img.crossOrigin = "anonymous";
                    img.onload = () => {
                        if (!uploadedBgImg) {
                            uploadedBgImg = img;
                            uploadedBgFilename = data.name;
                            viewport = { x: 0, y: 0, w: img.width, h: img.height, origRatio: img.width / img.height };
                            stagePadding = { top: 0, right: 0, bottom: 0, left: 0 };
                            currentRatioLabel = computeAspectRatio(img.width, img.height);
                            elements = []; stickers = []; sTags = []; aTags = []; frames = [];
                            undoStack = []; redoStack = [];
                            viewScale = 1.0; viewPan = { x: 0, y: 0 };
                            updateStageCanvases();
                            updateHistoryButtons();
                        } else {
                            saveState();
                            const sw = Math.min(280, img.width);
                            const sh = (img.height / img.width) * sw;
                            stickers.push({
                                id: `sticker_${Date.now()}`,
                                name: file.name.replace(/\.[^/.]+$/, ""),
                                img: img,
                                src: imageUrl,
                                filename: data.name,
                                x: viewport.x + viewport.w / 2 - sw / 2,
                                y: viewport.y + viewport.h / 2 - sh / 2,
                                w: sw, h: sh,
                                rotation: 0, flipX: false, flipY: false, opacity: 1.0,
                                visible: true
                            });
                            selectedElement = { type: 'sticker', index: stickers.length - 1 };
                            currentTool = "move";
                            updateToolButtons();
                            rebuildStickerCanvas();
                            render();
                            saveLightweightState();
                            updateLayersList();
                        }
                    };
                    img.src = imageUrl;
                } catch (err) { console.error("[MiniMax Canvas] Drop error:", err); }
            }
        });

        const renderSingleElement = (targetCtx, el, scaleRatio = 1.0) => {
            targetCtx.save();
            targetCtx.lineCap = "round";
            targetCtx.lineJoin = "round";

            if (el.type === "brush") {
                if (!el.points || el.points.length < 1) { targetCtx.restore(); return; }
                targetCtx.beginPath();
                if (el.isEraser) {
                    targetCtx.globalCompositeOperation = "destination-out";
                    targetCtx.lineWidth = el.size * scaleRatio * 2;
                } else {
                    targetCtx.globalCompositeOperation = "source-over";
                    targetCtx.strokeStyle = el.color;
                    targetCtx.lineWidth = el.size * scaleRatio;
                }
                targetCtx.moveTo(el.points[0].x, el.points[0].y);
                for (let i = 1; i < el.points.length; i++) targetCtx.lineTo(el.points[i].x, el.points[i].y);
                targetCtx.stroke();
            } else if (el.type === "line") {
                targetCtx.beginPath();
                targetCtx.strokeStyle = el.color;
                targetCtx.lineWidth = el.size * scaleRatio;
                targetCtx.moveTo(el.x1, el.y1);
                targetCtx.lineTo(el.x2, el.y2);
                targetCtx.stroke();
            } else if (el.type === "arrow") {
                targetCtx.strokeStyle = el.color;
                targetCtx.lineWidth = el.size * scaleRatio;
                targetCtx.beginPath();
                targetCtx.moveTo(el.x1, el.y1);
                targetCtx.lineTo(el.x2, el.y2);
                targetCtx.stroke();

                const headlen = Math.max(18 * scaleRatio, el.size * scaleRatio * 3.5);
                const angle = Math.atan2(el.y2 - el.y1, el.x2 - el.x1);
                targetCtx.beginPath();
                targetCtx.moveTo(el.x2 - headlen * Math.cos(angle - Math.PI / 6), el.y2 - headlen * Math.sin(angle - Math.PI / 6));
                targetCtx.lineTo(el.x2, el.y2);
                targetCtx.lineTo(el.x2 - headlen * Math.cos(angle + Math.PI / 6), el.y2 - headlen * Math.sin(angle + Math.PI / 6));
                targetCtx.stroke();
            } else if (el.type === "rect") {
                targetCtx.strokeStyle = el.color;
                targetCtx.fillStyle = el.color;
                targetCtx.lineWidth = el.size * scaleRatio;
                if (el.fill) targetCtx.fillRect(el.x, el.y, el.w, el.h);
                else targetCtx.strokeRect(el.x, el.y, el.w, el.h);
            } else if (el.type === "ellipse") {
                targetCtx.strokeStyle = el.color;
                targetCtx.fillStyle = el.color;
                targetCtx.lineWidth = el.size * scaleRatio;
                targetCtx.beginPath();
                targetCtx.ellipse(el.cx, el.cy, Math.abs(el.rx), Math.abs(el.ry), 0, 0, Math.PI * 2);
                if (el.fill) targetCtx.fill();
                else targetCtx.stroke();
            } else if (el.type === "text") {
                targetCtx.fillStyle = el.color;
                targetCtx.font = `bold ${el.size * scaleRatio * 3.5}px sans-serif`;
                targetCtx.textBaseline = "top";
                targetCtx.fillText(el.text, el.x, el.y);
            }
            targetCtx.restore();
        };

        const rebuildStickerCanvas = () => {
            stickerCtx.clearRect(0, 0, stickerCanvas.width, stickerCanvas.height);
            stickers.forEach(st => {
                if (st.visible === false || !st.img) return;
                stickerCtx.save();
                stickerCtx.translate(st.x + st.w / 2, st.y + st.h / 2);
                stickerCtx.rotate(st.rotation || 0);
                stickerCtx.scale(st.flipX ? -1 : 1, st.flipY ? -1 : 1);
                stickerCtx.globalAlpha = st.opacity !== undefined ? st.opacity : 1.0;
                stickerCtx.drawImage(st.img, -st.w / 2, -st.h / 2, st.w, st.h);
                stickerCtx.restore();
            });
        };

        const rebuildDrawCanvas = () => {
            drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
            const scaleRatio = viewport.w / 512;
            elements.forEach(el => renderSingleElement(drawCtx, el, scaleRatio));
        };

        const saveState = () => {
            undoStack.push({
                elements: JSON.parse(JSON.stringify(elements)),
                stickers: stickers.map(s => ({ ...s })),
                sTags: JSON.parse(JSON.stringify(sTags)),
                aTags: JSON.parse(JSON.stringify(aTags)),
                frames: JSON.parse(JSON.stringify(frames)),
                viewport: { ...viewport },
                stagePadding: { ...stagePadding }
            });
            if (undoStack.length > 25) undoStack.shift();
            redoStack = [];
            updateHistoryButtons();
        };

        const undo = () => {
            if (undoStack.length === 0) return;
            redoStack.push({
                elements: JSON.parse(JSON.stringify(elements)),
                stickers: stickers.map(s => ({ ...s })),
                sTags: JSON.parse(JSON.stringify(sTags)), aTags: JSON.parse(JSON.stringify(aTags)),
                frames: JSON.parse(JSON.stringify(frames)),
                viewport: { ...viewport }, stagePadding: { ...stagePadding }
            });
            const prev = undoStack.pop();
            elements = prev.elements; stickers = prev.stickers || []; sTags = prev.sTags; aTags = prev.aTags; frames = prev.frames;
            viewport = prev.viewport; stagePadding = prev.stagePadding;
            selectedElement = null; activeControl = null;
            updateStageCanvases();
            updateLayersList();
            updateHistoryButtons();
        };

        const redo = () => {
            if (redoStack.length === 0) return;
            undoStack.push({
                elements: JSON.parse(JSON.stringify(elements)),
                stickers: stickers.map(s => ({ ...s })),
                sTags: JSON.parse(JSON.stringify(sTags)), aTags: JSON.parse(JSON.stringify(aTags)),
                frames: JSON.parse(JSON.stringify(frames)),
                viewport: { ...viewport }, stagePadding: { ...stagePadding }
            });
            const next = redoStack.pop();
            elements = next.elements; stickers = next.stickers || []; sTags = next.sTags; aTags = next.aTags; frames = next.frames;
            viewport = next.viewport; stagePadding = next.stagePadding;
            selectedElement = null; activeControl = null;
            updateStageCanvases();
            updateLayersList();
            updateHistoryButtons();
        };

        // Lightweight State Persistence (< 2KB in LocalStorage! Zero Draft Save Errors!)
        const saveLightweightState = () => {
            if (canvasDataWidget) canvasDataWidget.value = "";
            if (bgDataWidget) bgDataWidget.value = "";

            node.properties = node.properties || {};
            node.properties["canvas_state"] = JSON.stringify({
                elements, sTags, aTags, frames,
                viewport, stagePadding,
                stickers: stickers.map(st => ({
                    id: st.id, name: st.name, src: st.src, filename: st.filename,
                    x: st.x, y: st.y, w: st.w, h: st.h,
                    rotation: st.rotation, flipX: st.flipX, flipY: st.flipY,
                    opacity: st.opacity, visible: st.visible
                })),
                uploadedBgFilename
            });
        };

        // On-Demand Serialization Hook (Only runs when clicking Queue Prompt / Run!)
        const exportCompositeCanvasDataUrl = () => {
            const tempCanvas = document.createElement("canvas");
            tempCanvas.width = drawCanvas.width;
            tempCanvas.height = drawCanvas.height;
            const tempCtx = tempCanvas.getContext("2d");

            tempCtx.drawImage(stickerCanvas, 0, 0);

            if (stagePadding.top > 0 || stagePadding.right > 0 || stagePadding.bottom > 0 || stagePadding.left > 0) {
                const scaleRatio = viewport.w / 512;
                tempCtx.save();
                tempCtx.strokeStyle = "rgba(255, 255, 255, 0.9)";
                tempCtx.lineWidth = 3 * scaleRatio;
                tempCtx.setLineDash([12 * scaleRatio, 8 * scaleRatio]);
                tempCtx.strokeRect(viewport.x, viewport.y, viewport.w, viewport.h);
                tempCtx.restore();
            }

            tempCtx.drawImage(drawCanvas, 0, 0);

            const scaleRatio = viewport.w / 512;
            frames.forEach(f => drawFrameBox(tempCtx, f, scaleRatio));
            sTags.forEach(tag => drawSTag(tempCtx, tag, scaleRatio));
            aTags.forEach(tag => drawATag(tempCtx, tag, scaleRatio));

            return tempCanvas.toDataURL("image/png");
        };

        const exportStageMetaJson = () => {
            return JSON.stringify({
                filename: uploadedBgFilename,
                viewport,
                stagePadding
            });
        };

        if (canvasDataWidget) {
            canvasDataWidget.serializeValue = () => exportCompositeCanvasDataUrl();
        }
        if (bgDataWidget) {
            bgDataWidget.serializeValue = () => exportStageMetaJson();
        }

        const render = () => {
            const rect = canvas.getBoundingClientRect();
            if (canvas.width !== rect.width || canvas.height !== rect.height) {
                canvas.width = rect.width || 512; canvas.height = rect.height || 340;
            }

            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.save();
            ctx.translate(viewPan.x, viewPan.y); ctx.scale(viewScale, viewScale);

            const aspect = bgCanvas.width / bgCanvas.height;
            let dw = canvas.width, dh = canvas.height;
            if (aspect > 1) dh = canvas.width / aspect; else dw = canvas.height * aspect;
            const dx = (canvas.width - dw) / 2; const dy = (canvas.height - dh) / 2;
            const renderScale = dw / bgCanvas.width;

            ctx.drawImage(bgCanvas, dx, dy, dw, dh);
            ctx.drawImage(stickerCanvas, dx, dy, dw, dh);
            ctx.drawImage(drawCanvas, dx, dy, dw, dh);

            if (currentShape) {
                ctx.save();
                ctx.translate(dx, dy);
                ctx.scale(renderScale, renderScale);
                renderSingleElement(ctx, currentShape, viewport.w / 512);
                ctx.restore();
            }

            renderStageAndViewportGizmo(ctx, dx, dy, dw, dh, renderScale);

            if (selectedElement?.type === 'sticker' && stickers[selectedElement.index]) {
                renderStickerGizmo(ctx, stickers[selectedElement.index], renderScale, dx, dy);
            }

            frames.forEach(f => {
                drawFrameBox(ctx, {
                    id: f.id, x: dx + f.x * renderScale, y: dy + f.y * renderScale, w: f.w * renderScale, h: f.h * renderScale,
                    isSelected: selectedElement?.type === 'frame' && selectedElement.index === frames.indexOf(f)
                }, 1.0);
            });

            sTags.forEach(tag => {
                drawSTag(ctx, {
                    id: tag.id, x: dx + tag.x * renderScale, y: dy + tag.y * renderScale,
                    isSelected: selectedElement?.type === 'S' && selectedElement.index === sTags.indexOf(tag)
                }, 1.0);
            });

            aTags.forEach(tag => {
                drawATag(ctx, {
                    id: tag.id, x: dx + tag.x * renderScale, y: dy + tag.y * renderScale,
                    isSelected: selectedElement?.type === 'A' && selectedElement.index === aTags.indexOf(tag)
                }, 1.0);
            });

            ctx.restore();
            renderHudBadge();
            updateStickerFloatingBar(renderScale, dx, dy);
        };

        const renderStageAndViewportGizmo = (targetCtx, dx, dy, dw, dh, renderScale) => {
            const vx = dx + viewport.x * renderScale;
            const vy = dy + viewport.y * renderScale;
            const vw = viewport.w * renderScale;
            const vh = viewport.h * renderScale;

            targetCtx.save();
            targetCtx.strokeStyle = "rgba(255, 255, 255, 0.85)";
            targetCtx.lineWidth = 1.5;
            targetCtx.setLineDash([6, 5]);
            targetCtx.strokeRect(vx, vy, vw, vh);

            targetCtx.setLineDash([]);
            targetCtx.fillStyle = "rgba(24, 24, 27, 0.8)";
            targetCtx.fillRect(vx, vy - 18, 125, 18);
            targetCtx.fillStyle = "#38bdf8";
            targetCtx.font = "bold 10px sans-serif";
            targetCtx.fillText("📷 Camera Viewport", vx + 5, vy - 5);

            targetCtx.fillStyle = "#38bdf8";
            targetCtx.strokeStyle = "#ffffff";
            targetCtx.lineWidth = 1.5;
            const cr = 5;
            [
                [vx, vy], [vx + vw, vy],
                [vx + vw, vy + vh], [vx, vy + vh]
            ].forEach(([hx, hy]) => {
                targetCtx.beginPath();
                targetCtx.rect(hx - cr, hy - cr, cr * 2, cr * 2);
                targetCtx.fill();
                targetCtx.stroke();
            });

            targetCtx.fillStyle = "#22c55e";
            targetCtx.strokeStyle = "#ffffff";
            targetCtx.lineWidth = 1.5;
            const pw = 34, ph = 8;

            targetCtx.beginPath(); targetCtx.roundRect(dx + dw / 2 - pw / 2, dy - ph / 2, pw, ph, 4); targetCtx.fill(); targetCtx.stroke();
            targetCtx.beginPath(); targetCtx.roundRect(dx + dw / 2 - pw / 2, dy + dh - ph / 2, pw, ph, 4); targetCtx.fill(); targetCtx.stroke();
            targetCtx.beginPath(); targetCtx.roundRect(dx - ph / 2, dy + dh / 2 - pw / 2, ph, pw, 4); targetCtx.fill(); targetCtx.stroke();
            targetCtx.beginPath(); targetCtx.roundRect(dx + dw - ph / 2, dy + dh / 2 - pw / 2, ph, pw, 4); targetCtx.fill(); targetCtx.stroke();

            targetCtx.restore();
        };

        const renderStickerGizmo = (targetCtx, st, renderScale, dx, dy) => {
            const cx = dx + (st.x + st.w / 2) * renderScale;
            const cy = dy + (st.y + st.h / 2) * renderScale;
            const sw = st.w * renderScale;
            const sh = st.h * renderScale;

            targetCtx.save();
            targetCtx.translate(cx, cy);
            targetCtx.rotate(st.rotation || 0);

            targetCtx.strokeStyle = "#38bdf8";
            targetCtx.lineWidth = 1.5;
            targetCtx.setLineDash([5, 4]);
            targetCtx.strokeRect(-sw / 2, -sh / 2, sw, sh);

            targetCtx.setLineDash([]);
            targetCtx.fillStyle = "#ffffff";
            targetCtx.strokeStyle = "#0284c7";
            targetCtx.lineWidth = 2;
            const handleR = 5.5;

            [
                [-sw / 2, -sh / 2], [sw / 2, -sh / 2],
                [sw / 2, sh / 2], [-sw / 2, sh / 2]
            ].forEach(([hx, hy]) => {
                targetCtx.beginPath();
                targetCtx.arc(hx, hy, handleR, 0, Math.PI * 2);
                targetCtx.fill(); targetCtx.stroke();
            });

            const rotY = -sh / 2 - 22;
            targetCtx.beginPath(); targetCtx.moveTo(0, -sh / 2); targetCtx.lineTo(0, rotY); targetCtx.stroke();
            targetCtx.fillStyle = "#38bdf8";
            targetCtx.beginPath(); targetCtx.arc(0, rotY, 6, 0, Math.PI * 2); targetCtx.fill(); targetCtx.stroke();

            targetCtx.restore();
        };

        const renderHudBadge = () => {
            ctx.save();
            ctx.font = "bold 11px sans-serif";
            const badgeText = `📐 ${currentRatioLabel}`;
            const textMetrics = ctx.measureText(badgeText);
            const badgeW = textMetrics.width + 16;
            const badgeH = 22;
            const badgeX = 8;
            const badgeY = canvas.height - badgeH - 8;

            ctx.fillStyle = "rgba(15, 23, 42, 0.9)";
            ctx.strokeStyle = "rgba(71, 85, 105, 0.7)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 4);
            ctx.fill(); ctx.stroke();

            ctx.fillStyle = "#38bdf8";
            ctx.textAlign = "left"; ctx.textBaseline = "middle";
            ctx.fillText(badgeText, badgeX + 8, badgeY + badgeH / 2);
            ctx.restore();
        };

        const drawSTag = (targetCtx, tag, scale = 1.0) => {
            const size = 32 * scale;
            targetCtx.save(); targetCtx.translate(tag.x, tag.y);
            targetCtx.beginPath();
            targetCtx.moveTo(-size / 2, -size / 2); targetCtx.lineTo(size / 2, -size / 2); targetCtx.lineTo(0, size / 2);
            targetCtx.closePath();
            targetCtx.fillStyle = "#8A2BE2"; targetCtx.fill();
            targetCtx.strokeStyle = tag.isSelected ? "#00FFFF" : "#FFFFFF";
            targetCtx.lineWidth = (tag.isSelected ? 3 : 2) * scale; targetCtx.stroke();
            targetCtx.fillStyle = "#FFFFFF"; targetCtx.font = `bold ${12 * scale}px sans-serif`;
            targetCtx.textAlign = "center"; targetCtx.textBaseline = "middle"; targetCtx.fillText(tag.id, 0, -size / 6);
            targetCtx.restore();
        };

        const drawATag = (targetCtx, tag, scale = 1.0) => {
            const size = 32 * scale;
            targetCtx.save(); targetCtx.translate(tag.x, tag.y);
            targetCtx.beginPath();
            targetCtx.moveTo(0, -size / 2); targetCtx.lineTo(size / 2, size / 2); targetCtx.lineTo(-size / 2, size / 2);
            targetCtx.closePath();
            targetCtx.fillStyle = "#8A2BE2"; targetCtx.fill();
            targetCtx.strokeStyle = tag.isSelected ? "#00FFFF" : "#FFFFFF";
            targetCtx.lineWidth = (tag.isSelected ? 3 : 2) * scale; targetCtx.stroke();
            targetCtx.fillStyle = "#FFFFFF"; targetCtx.font = `bold ${12 * scale}px sans-serif`;
            targetCtx.textAlign = "center"; targetCtx.textBaseline = "middle"; targetCtx.fillText(tag.id, 0, size / 6);
            targetCtx.restore();
        };

        const drawFrameBox = (targetCtx, frame, scale = 1.0) => {
            targetCtx.save();
            const color = frame.isSelected ? "#00FFFF" : "#FFD700";
            targetCtx.strokeStyle = color;
            targetCtx.lineWidth = (frame.isSelected ? 3.5 : 2.5) * scale;
            targetCtx.setLineDash([8 * scale, 4 * scale]);
            targetCtx.strokeRect(frame.x, frame.y, frame.w, frame.h);

            const headerW = Math.max(100 * scale, Math.min(frame.w * 0.4, 160 * scale));
            const headerH = 26 * scale;
            targetCtx.setLineDash([]);
            targetCtx.fillStyle = color;
            targetCtx.fillRect(frame.x, frame.y - headerH, headerW, headerH);

            targetCtx.fillStyle = "#000000";
            targetCtx.font = `bold ${13 * scale}px sans-serif`;
            targetCtx.textAlign = "center"; targetCtx.textBaseline = "middle";
            targetCtx.fillText(frame.id, frame.x + headerW / 2, frame.y - headerH / 2);

            const handleSize = 18 * scale;
            targetCtx.fillStyle = color;
            targetCtx.fillRect(frame.x + frame.w - handleSize, frame.y + frame.h - handleSize, handleSize, handleSize);
            targetCtx.strokeStyle = "#000";
            targetCtx.lineWidth = 1 * scale;
            targetCtx.strokeRect(frame.x + frame.w - handleSize, frame.y + frame.h - handleSize, handleSize, handleSize);
            targetCtx.restore();
        };

        const getCanvasPos = (e) => {
            const rect = canvas.getBoundingClientRect();
            const aspect = bgCanvas.width / bgCanvas.height;
            let dw = canvas.width, dh = canvas.height;
            if (aspect > 1) dh = canvas.width / aspect; else dw = canvas.height * aspect;
            const dx = (canvas.width - dw) / 2; const dy = (canvas.height - dh) / 2;

            const vx = ((e.clientX - rect.left) * (canvas.width / rect.width) - viewPan.x) / viewScale;
            const vy = ((e.clientY - rect.top) * (canvas.height / rect.height) - viewPan.y) / viewScale;
            return { 
                x: ((vx - dx) / dw) * drawCanvas.width, 
                y: ((vy - dy) / dh) * drawCanvas.height,
                screenScale: dw / drawCanvas.width,
                clientToCanvasScale: (dw / drawCanvas.width) * viewScale * (rect.width / canvas.width)
            };
        };

        const hitTestControls = (pos, e) => {
            const screenTol = 22 / (pos.screenScale * viewScale);
            const totalW = bgCanvas.width, totalH = bgCanvas.height;

            // 1. Selected Sticker Gizmo Handles
            if (selectedElement?.type === 'sticker') {
                const st = stickers[selectedElement.index];
                if (st && st.visible !== false) {
                    const cx = st.x + st.w / 2, cy = st.y + st.h / 2;
                    const rad = -(st.rotation || 0);
                    const lx = (pos.x - cx) * Math.cos(rad) - (pos.y - cy) * Math.sin(rad);
                    const ly = (pos.x - cx) * Math.sin(rad) + (pos.y - cy) * Math.cos(rad);

                    const rotY = -st.h / 2 - 22 / pos.screenScale;
                    if (Math.hypot(lx, ly - rotY) < screenTol * 1.2) {
                        return { type: 'sticker_rotate', index: selectedElement.index, cx, cy, startAngle: Math.atan2(pos.y - cy, pos.x - cx), initRot: st.rotation || 0 };
                    }
                    const corners = [
                        { name: 'tl', x: -st.w / 2, y: -st.h / 2 },
                        { name: 'tr', x: st.w / 2, y: -st.h / 2 },
                        { name: 'br', x: st.w / 2, y: st.h / 2 },
                        { name: 'bl', x: -st.w / 2, y: st.h / 2 }
                    ];
                    for (const c of corners) {
                        if (Math.hypot(lx - c.x, ly - c.y) < screenTol * 1.2) {
                            const startDist = Math.max(10, Math.hypot(pos.x - cx, pos.y - cy));
                            return { type: 'sticker_scale', index: selectedElement.index, cx, cy, startW: st.w, startH: st.h, startDist };
                        }
                    }
                }
            }

            // 2. S & A Tags
            for (let i = sTags.length - 1; i >= 0; i--) {
                if (Math.hypot(pos.x - sTags[i].x, pos.y - sTags[i].y) < screenTol * 1.1)
                    return { type: 'S_move', index: i, offsetX: pos.x - sTags[i].x, offsetY: pos.y - sTags[i].y };
            }
            for (let i = aTags.length - 1; i >= 0; i--) {
                if (Math.hypot(pos.x - aTags[i].x, pos.y - aTags[i].y) < screenTol * 1.1)
                    return { type: 'A_move', index: i, offsetX: pos.x - aTags[i].x, offsetY: pos.y - aTags[i].y };
            }

            // 3. Storyboard Frames
            for (let i = frames.length - 1; i >= 0; i--) {
                const f = frames[i];
                if (Math.abs(pos.x - (f.x + f.w)) <= screenTol * 1.2 && Math.abs(pos.y - (f.y + f.h)) <= screenTol * 1.2) {
                    return { type: 'frame_resize', index: i, startW: f.w, startH: f.h, startX: pos.x, startY: pos.y };
                }
                const headerW = Math.max(100, Math.min(f.w * 0.4, 160)) / pos.screenScale;
                const headerH = 28 / pos.screenScale;
                if (pos.x >= f.x - screenTol && pos.x <= f.x + headerW + screenTol && pos.y >= f.y - headerH - screenTol && pos.y <= f.y + screenTol) {
                    return { type: 'frame_move', index: i, offsetX: pos.x - f.x, offsetY: pos.y - f.y };
                }
                if (currentTool === "move") {
                    const nearL = Math.abs(pos.x - f.x) <= screenTol && (pos.y >= f.y && pos.y <= f.y + f.h);
                    const nearR = Math.abs(pos.x - (f.x + f.w)) <= screenTol && (pos.y >= f.y && pos.y <= f.y + f.h);
                    const nearT = Math.abs(pos.y - f.y) <= screenTol && (pos.x >= f.x && pos.x <= f.x + f.w);
                    const nearB = Math.abs(pos.y - (f.y + f.h)) <= screenTol && (pos.x >= f.x && pos.x <= f.x + f.w);
                    if (nearL || nearR || nearT || nearB) {
                        return { type: 'frame_move', index: i, offsetX: pos.x - f.x, offsetY: pos.y - f.y };
                    }
                }
            }

            // 4. Stickers Body
            if (currentTool === "move" || selectedElement?.type === 'sticker') {
                for (let i = stickers.length - 1; i >= 0; i--) {
                    if (currentTool !== "move" && selectedElement?.index !== i) continue;
                    const st = stickers[i];
                    if (st.visible === false) continue;
                    const cx = st.x + st.w / 2, cy = st.y + st.h / 2;
                    const rad = -(st.rotation || 0);
                    const lx = (pos.x - cx) * Math.cos(rad) - (pos.y - cy) * Math.sin(rad);
                    const ly = (pos.x - cx) * Math.sin(rad) + (pos.y - cy) * Math.cos(rad);
                    if (Math.abs(lx) <= st.w / 2 && Math.abs(ly) <= st.h / 2) {
                        return { type: 'sticker_move', index: i, offsetX: pos.x - st.x, offsetY: pos.y - st.y };
                    }
                }
            }

            // 5. Outer Stage 4 Green Pill Handles
            const pillHalfW = 24 / (pos.screenScale * viewScale);
            if (Math.abs(pos.y - 0) < screenTol && Math.abs(pos.x - totalW / 2) < pillHalfW) {
                return { type: 'margin_pull_top', startPadding: stagePadding.top, startClientY: e?.clientY || 0, scale: pos.clientToCanvasScale };
            }
            if (Math.abs(pos.y - totalH) < screenTol && Math.abs(pos.x - totalW / 2) < pillHalfW) {
                return { type: 'margin_pull_bottom', startPadding: stagePadding.bottom, startClientY: e?.clientY || 0, scale: pos.clientToCanvasScale };
            }
            if (Math.abs(pos.x - 0) < screenTol && Math.abs(pos.y - totalH / 2) < pillHalfW) {
                return { type: 'margin_pull_left', startPadding: stagePadding.left, startClientX: e?.clientX || 0, scale: pos.clientToCanvasScale };
            }
            if (Math.abs(pos.x - totalW) < screenTol && Math.abs(pos.y - totalH / 2) < pillHalfW) {
                return { type: 'margin_pull_right', startPadding: stagePadding.right, startClientX: e?.clientX || 0, scale: pos.clientToCanvasScale };
            }

            // 6. Inner Viewport 4 Blue Corner Handles
            const vx = viewport.x, vy = viewport.y, vw = viewport.w, vh = viewport.h;
            const vpCorners = [
                { name: 'tl', x: vx, y: vy, signX: 1, signY: 1 },
                { name: 'tr', x: vx + vw, y: vy, signX: -1, signY: 1 },
                { name: 'br', x: vx + vw, y: vy + vh, signX: -1, signY: -1 },
                { name: 'bl', x: vx, y: vy + vh, signX: 1, signY: -1 }
            ];
            for (const c of vpCorners) {
                if (Math.hypot(pos.x - c.x, pos.y - c.y) < screenTol) {
                    return {
                        type: 'viewport_corner_margin',
                        corner: c.name, signX: c.signX, signY: c.signY,
                        startPad: { ...stagePadding },
                        startClientX: e?.clientX || 0,
                        startClientY: e?.clientY || 0,
                        scale: pos.clientToCanvasScale
                    };
                }
            }

            return null;
        };

        let dragStartPos = null;

        canvas.addEventListener("pointermove", (e) => {
            if (isDrawing || isPanning || activeControl) return;
            const pos = getCanvasPos(e);
            const hit = hitTestControls(pos, e);
            if (hit) {
                if (hit.type.includes('rotate')) canvas.style.cursor = "alias";
                else if (hit.type.includes('corner') || hit.type.includes('scale') || hit.type.includes('resize')) canvas.style.cursor = "nwse-resize";
                else if (hit.type.includes('pull_top') || hit.type.includes('pull_bottom')) canvas.style.cursor = "ns-resize";
                else if (hit.type.includes('pull_left') || hit.type.includes('pull_right')) canvas.style.cursor = "ew-resize";
                else canvas.style.cursor = "move";
            } else {
                canvas.style.cursor = isPanMode ? "grab" : (currentTool === "move" ? "default" : "crosshair");
            }
        });

        canvas.addEventListener("pointerdown", (e) => {
            container.focus();
            const pos = getCanvasPos(e);

            if (isPanMode || e.button === 1 || e.spaceKey) {
                isPanning = true; panStart = { x: e.clientX - viewPan.x, y: e.clientY - viewPan.y };
                canvas.style.cursor = "grabbing"; return;
            }

            const hit = hitTestControls(pos, e);
            if (hit) {
                saveState();
                activeControl = hit;
                if (hit.type.startsWith('sticker')) selectedElement = { type: 'sticker', index: hit.index };
                else if (hit.type === 'S_move') selectedElement = { type: 'S', index: hit.index };
                else if (hit.type === 'A_move') selectedElement = { type: 'A', index: hit.index };
                else if (hit.type.startsWith('frame')) selectedElement = { type: 'frame', index: hit.index };
                else if (hit.type.startsWith('viewport') || hit.type.startsWith('margin')) selectedElement = { type: 'viewport' };
                
                canvas.setPointerCapture(e.pointerId);
                updateLayersList();
                render(); return;
            }

            selectedElement = null;
            updateLayersList();

            if (currentTool === "move") {
                render();
                return;
            }

            if (currentTool === "text") {
                const text = prompt("Enter directing note / keyword annotation:");
                if (text) {
                    saveState();
                    elements.push({ type: "text", text, color: currentColor, size: brushSize, x: pos.x, y: pos.y });
                    rebuildDrawCanvas(); render(); saveLightweightState();
                }
                return;
            }

            saveState();
            isDrawing = true; dragStartPos = { x: pos.x, y: pos.y };

            if (currentTool === "brush" || currentTool === "eraser") {
                elements.push({ type: "brush", color: currentColor, size: brushSize, isEraser: (currentTool === "eraser"), points: [{ x: pos.x, y: pos.y }] });
                rebuildDrawCanvas(); render();
            }
        });

        canvas.addEventListener("pointermove", (e) => {
            if (isPanning) { viewPan.x = e.clientX - panStart.x; viewPan.y = e.clientY - panStart.y; render(); return; }
            const pos = getCanvasPos(e);

            if (activeControl) {
                if (activeControl.type === 'sticker_move') {
                    stickers[activeControl.index].x = pos.x - activeControl.offsetX;
                    stickers[activeControl.index].y = pos.y - activeControl.offsetY;
                    rebuildStickerCanvas(); render();
                } else if (activeControl.type === 'sticker_scale') {
                    const st = stickers[activeControl.index];
                    const curDist = Math.max(10, Math.hypot(pos.x - activeControl.cx, pos.y - activeControl.cy));
                    const ratio = curDist / activeControl.startDist;
                    const newW = Math.max(24, activeControl.startW * ratio);
                    const newH = Math.max(24, activeControl.startH * ratio);
                    st.x = activeControl.cx - newW / 2;
                    st.y = activeControl.cy - newH / 2;
                    st.w = newW; st.h = newH;
                    rebuildStickerCanvas(); render();
                } else if (activeControl.type === 'sticker_rotate') {
                    const curAngle = Math.atan2(pos.y - activeControl.cy, pos.x - activeControl.cx);
                    stickers[activeControl.index].rotation = activeControl.initRot + (curAngle - activeControl.startAngle);
                    rebuildStickerCanvas(); render();
                } else if (activeControl.type === 'viewport_corner_margin') {
                    const deltaScreen = ((e.clientX - activeControl.startClientX) * activeControl.signX + (e.clientY - activeControl.startClientY) * activeControl.signY) * 0.5;
                    const deltaCanvas = Math.round(deltaScreen / activeControl.scale);

                    const newLeft = Math.max(0, activeControl.startPad.left + deltaCanvas);
                    const newRight = Math.max(0, activeControl.startPad.right + deltaCanvas);
                    const newTop = Math.max(0, Math.round(activeControl.startPad.top + deltaCanvas / viewport.origRatio));
                    const newBottom = Math.max(0, Math.round(activeControl.startPad.bottom + deltaCanvas / viewport.origRatio));

                    const dL = newLeft - stagePadding.left;
                    const dT = newTop - stagePadding.top;
                    stagePadding = { left: newLeft, right: newRight, top: newTop, bottom: newBottom };
                    shiftAllCoordinates(dL, dT);
                    updateStageCanvases();
                } else if (activeControl.type === 'margin_pull_top') {
                    const dyCanvas = Math.round((e.clientY - activeControl.startClientY) / activeControl.scale);
                    const newTop = Math.max(0, activeControl.startPadding - dyCanvas);
                    const dT = newTop - stagePadding.top;
                    stagePadding.top = newTop;
                    shiftAllCoordinates(0, dT);
                    updateStageCanvases();
                } else if (activeControl.type === 'margin_pull_bottom') {
                    const dyCanvas = Math.round((e.clientY - activeControl.startClientY) / activeControl.scale);
                    stagePadding.bottom = Math.max(0, activeControl.startPadding + dyCanvas);
                    updateStageCanvases();
                } else if (activeControl.type === 'margin_pull_left') {
                    const dxCanvas = Math.round((e.clientX - activeControl.startClientX) / activeControl.scale);
                    const newLeft = Math.max(0, activeControl.startPadding - dxCanvas);
                    const dL = newLeft - stagePadding.left;
                    stagePadding.left = newLeft;
                    shiftAllCoordinates(dL, 0);
                    updateStageCanvases();
                } else if (activeControl.type === 'margin_pull_right') {
                    const dxCanvas = Math.round((e.clientX - activeControl.startClientX) / activeControl.scale);
                    stagePadding.right = Math.max(0, activeControl.startPadding + dxCanvas);
                    updateStageCanvases();
                } else if (activeControl.type === 'S_move') {
                    sTags[activeControl.index].x = pos.x - activeControl.offsetX;
                    sTags[activeControl.index].y = pos.y - activeControl.offsetY;
                    render();
                } else if (activeControl.type === 'A_move') {
                    aTags[activeControl.index].x = pos.x - activeControl.offsetX;
                    aTags[activeControl.index].y = pos.y - activeControl.offsetY;
                    render();
                } else if (activeControl.type === 'frame_move') {
                    frames[activeControl.index].x = pos.x - activeControl.offsetX;
                    frames[activeControl.index].y = pos.y - activeControl.offsetY;
                    render();
                } else if (activeControl.type === 'frame_resize') {
                    frames[activeControl.index].w = Math.max(60, activeControl.startW + (pos.x - activeControl.startX));
                    frames[activeControl.index].h = Math.max(40, activeControl.startH + (pos.y - activeControl.startY));
                    render();
                }
                return;
            }

            if (!isDrawing || !dragStartPos) return;

            if (currentTool === "brush" || currentTool === "eraser") {
                const cur = elements[elements.length - 1];
                if (cur && cur.type === "brush") { cur.points.push({ x: pos.x, y: pos.y }); rebuildDrawCanvas(); render(); }
            } else if (currentTool === "line") {
                currentShape = { type: "line", color: currentColor, size: brushSize, x1: dragStartPos.x, y1: dragStartPos.y, x2: pos.x, y2: pos.y }; render();
            } else if (currentTool === "arrow") {
                currentShape = { type: "arrow", color: currentColor, size: brushSize, x1: dragStartPos.x, y1: dragStartPos.y, x2: pos.x, y2: pos.y }; render();
            } else if (currentTool === "rect") {
                currentShape = { type: "rect", color: currentColor, size: brushSize, fill: isFilled, x: Math.min(dragStartPos.x, pos.x), y: Math.min(dragStartPos.y, pos.y), w: Math.abs(pos.x - dragStartPos.x), h: Math.abs(pos.y - dragStartPos.y) }; render();
            } else if (currentTool === "ellipse") {
                currentShape = { type: "ellipse", color: currentColor, size: brushSize, fill: isFilled, cx: (dragStartPos.x + pos.x) / 2, cy: (dragStartPos.y + pos.y) / 2, rx: Math.abs(pos.x - dragStartPos.x) / 2, ry: Math.abs(pos.y - dragStartPos.y) / 2 }; render();
            }
        });

        const handlePointerUp = (e) => {
            if (activeControl) {
                if (e.pointerId) canvas.releasePointerCapture(e.pointerId);
                activeControl = null;
                canvas.style.cursor = isPanMode ? "grab" : (currentTool === "move" ? "default" : "crosshair");
                saveLightweightState();
            }
            if (isDrawing) {
                isDrawing = false;
                if (currentShape) { elements.push(currentShape); currentShape = null; rebuildDrawCanvas(); }
                dragStartPos = null; render(); saveLightweightState();
            }
            if (isPanning) {
                isPanning = false; canvas.style.cursor = isPanMode ? "grab" : "crosshair";
            }
        };

        canvas.addEventListener("pointerup", handlePointerUp);
        canvas.addEventListener("pointerleave", handlePointerUp);
        canvas.addEventListener("wheel", (e) => {
            e.preventDefault(); viewScale = Math.min(Math.max(0.2, viewScale * (e.deltaY < 0 ? 1.15 : 0.85)), 5.0); render();
        }, { passive: false });

        const handleKeyDown = (e) => {
            const isSelf = isHovered || container.contains(document.activeElement);
            if (!isSelf) return;

            const isCopy = (e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C");
            const isPaste = (e.ctrlKey || e.metaKey) && (e.key === "v" || e.key === "V");
            const isUndo = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z";
            const isRedo = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y";
            const isDelete = e.key === "Delete" || e.key === "Backspace";

            if (isCopy || isPaste || isUndo || isRedo || isDelete) {
                e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
            }

            if (isUndo) {
                if (e.shiftKey) redo(); else undo();
            } else if (isRedo) {
                redo();
            } else if (isCopy) {
                if (selectedElement) {
                    if (selectedElement.type === 'A' && aTags[selectedElement.index]) {
                        clipboardItem = { type: 'A', data: JSON.parse(JSON.stringify(aTags[selectedElement.index])) };
                    } else if (selectedElement.type === 'S' && sTags[selectedElement.index]) {
                        clipboardItem = { type: 'S', data: JSON.parse(JSON.stringify(sTags[selectedElement.index])) };
                    } else if (selectedElement.type === 'sticker' && stickers[selectedElement.index]) {
                        clipboardItem = { type: 'sticker', data: { ...stickers[selectedElement.index] } };
                    }
                }
            } else if (isPaste) {
                if (clipboardItem) {
                    saveState();
                    const newItem = JSON.parse(JSON.stringify(clipboardItem.data));
                    newItem.x += 30; newItem.y += 30; 
                    if (clipboardItem.type === 'A') {
                        aTags.push(newItem); selectedElement = { type: 'A', index: aTags.length - 1 };
                    } else if (clipboardItem.type === 'S') {
                        sTags.push(newItem); selectedElement = { type: 'S', index: sTags.length - 1 };
                    } else if (clipboardItem.type === 'sticker') {
                        newItem.id = `sticker_${Date.now()}`;
                        newItem.img = clipboardItem.data.img;
                        stickers.push(newItem); selectedElement = { type: 'sticker', index: stickers.length - 1 };
                        rebuildStickerCanvas(); updateLayersList();
                    }
                    render(); saveLightweightState();
                }
            } else if (isDelete) {
                if (selectedElement) {
                    saveState();
                    if (selectedElement.type === "sticker") { stickers.splice(selectedElement.index, 1); rebuildStickerCanvas(); updateLayersList(); }
                    else if (selectedElement.type === "A") aTags.splice(selectedElement.index, 1);
                    else if (selectedElement.type === "S") sTags.splice(selectedElement.index, 1);
                    else if (selectedElement.type === "frame") frames.splice(selectedElement.index, 1);
                    selectedElement = null;
                    render(); saveLightweightState();
                }
            }
        };
        window.addEventListener("keydown", handleKeyDown, true);
        node.onRemoved = () => window.removeEventListener("keydown", handleKeyDown, true);

        // =================================================================
        // Sticker Floating Toolbar
        // =================================================================
        const stickerFloatingBar = document.createElement("div");
        stickerFloatingBar.style.cssText = "position: absolute; display: none; gap: 4px; background: rgba(24, 24, 27, 0.95); padding: 4px 6px; border-radius: 6px; border: 1px solid #52525b; box-shadow: 0 4px 16px rgba(0,0,0,0.5); z-index: 100; pointer-events: auto;";

        const createBarBtn = (txt, title, onClick) => {
            const b = document.createElement("button");
            b.textContent = txt; b.title = title;
            b.style.cssText = "padding: 3px 6px; background: #27272a; color: #f4f4f5; border: 1px solid #3f3f46; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: 500;";
            b.onclick = (e) => { e.stopPropagation(); onClick(); };
            return b;
        };

        stickerFloatingBar.appendChild(createBarBtn("⇄ Flip X", "Horizontal Flip", () => {
            if (selectedElement?.type === 'sticker' && stickers[selectedElement.index]) {
                saveState();
                stickers[selectedElement.index].flipX = !stickers[selectedElement.index].flipX;
                rebuildStickerCanvas(); render(); saveLightweightState();
            }
        }));

        stickerFloatingBar.appendChild(createBarBtn("⇅ Flip Y", "Vertical Flip", () => {
            if (selectedElement?.type === 'sticker' && stickers[selectedElement.index]) {
                saveState();
                stickers[selectedElement.index].flipY = !stickers[selectedElement.index].flipY;
                rebuildStickerCanvas(); render(); saveLightweightState();
            }
        }));

        stickerFloatingBar.appendChild(createBarBtn("⬆️ Front", "Bring to Front", () => {
            if (selectedElement?.type === 'sticker' && stickers[selectedElement.index]) {
                saveState();
                const item = stickers.splice(selectedElement.index, 1)[0];
                stickers.push(item);
                selectedElement.index = stickers.length - 1;
                rebuildStickerCanvas(); render(); saveLightweightState(); updateLayersList();
            }
        }));

        stickerFloatingBar.appendChild(createBarBtn("💾 Save", "Save Sticker to Local Library", async () => {
            if (selectedElement?.type === 'sticker' && stickers[selectedElement.index]) {
                const st = stickers[selectedElement.index];
                const stickerName = prompt("Enter sticker name for library:", st.name || `sticker_${Date.now()}`);
                if (!stickerName) return;

                const offCanvas = document.createElement("canvas");
                offCanvas.width = st.img.naturalWidth || st.w;
                offCanvas.height = st.img.naturalHeight || st.h;
                const oCtx = offCanvas.getContext("2d");
                oCtx.translate(offCanvas.width / 2, offCanvas.height / 2);
                oCtx.scale(st.flipX ? -1 : 1, st.flipY ? -1 : 1);
                oCtx.drawImage(st.img, -offCanvas.width / 2, -offCanvas.height / 2);

                try {
                    const res = await fetch("/minimax/stickers/save", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            name: stickerName,
                            image_data: offCanvas.toDataURL("image/png")
                        })
                    });
                    const resData = await res.json();
                    if (resData.success) {
                        st.src = resData.url;
                        st.name = resData.name;
                        saveLightweightState();
                        loadStickersFromAPI();
                        alert(`✅ Sticker saved: ${resData.name}`);
                    } else {
                        alert(`❌ Failed: ${resData.error}`);
                    }
                } catch (err) {
                    alert("❌ Server connection error");
                }
            }
        }));

        stickerFloatingBar.appendChild(createBarBtn("🗑️ Delete", "Delete Sticker", () => {
            if (selectedElement?.type === 'sticker' && stickers[selectedElement.index]) {
                saveState();
                stickers.splice(selectedElement.index, 1);
                selectedElement = null;
                rebuildStickerCanvas(); render(); saveLightweightState(); updateLayersList();
            }
        }));

        container.appendChild(stickerFloatingBar);

        const updateStickerFloatingBar = (renderScale, dx, dy) => {
            if (selectedElement?.type === 'sticker' && stickers[selectedElement.index]) {
                const st = stickers[selectedElement.index];
                const screenX = dx + (st.x + st.w / 2) * renderScale;
                const screenY = dy + (st.y) * renderScale;
                const vx = viewPan.x + screenX * viewScale;
                const vy = viewPan.y + (screenY - 38) * viewScale;

                stickerFloatingBar.style.left = `${Math.max(10, Math.min(canvas.clientWidth - 260, vx - 120))}px`;
                stickerFloatingBar.style.top = `${Math.max(10, vy)}px`;
                stickerFloatingBar.style.display = "flex";
            } else {
                stickerFloatingBar.style.display = "none";
            }
        };

        // =================================================================
        // Flat Sticker Drawer (Library & Active Layers Dual-Tab)
        // =================================================================
        const stickerDrawer = document.createElement("div");
        stickerDrawer.style.cssText = "position: absolute; right: 0; top: 0; width: 240px; height: 100%; background: rgba(18, 18, 20, 0.98); border-left: 1px solid #3f3f46; display: none; flex-direction: column; z-index: 200; box-shadow: -4px 0 16px rgba(0,0,0,0.5); border-radius: 0 8px 8px 0; padding: 8px; box-sizing: border-box;";

        const drawerHeader = document.createElement("div");
        drawerHeader.style.cssText = "display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #27272a; padding-bottom: 6px; margin-bottom: 6px;";
        drawerHeader.innerHTML = "<span style='font-size:12px;font-weight:bold;color:#f4f4f5;'>⭐ Stickers & Layers</span>";
        
        const btnCloseDrawer = document.createElement("button");
        btnCloseDrawer.textContent = "✕";
        btnCloseDrawer.style.cssText = "background: transparent; color: #a1a1aa; border: none; cursor: pointer; font-size: 14px;";
        btnCloseDrawer.onclick = () => stickerDrawer.style.display = "none";
        drawerHeader.appendChild(btnCloseDrawer);

        const tabsBar = document.createElement("div");
        tabsBar.style.cssText = "display: flex; gap: 4px; margin-bottom: 6px;";
        const btnTabLib = document.createElement("button");
        btnTabLib.textContent = "Library";
        const btnTabLayers = document.createElement("button");
        btnTabLayers.textContent = "Layers";

        let currentDrawerTab = "lib";
        const updateDrawerTabs = () => {
            btnTabLib.style.cssText = `flex:1; padding:3px; font-size:11px; border-radius:3px; cursor:pointer; ${currentDrawerTab === 'lib' ? 'background:#3b82f6;color:#fff;border:1px solid #60a5fa;' : 'background:#27272a;color:#a1a1aa;border:1px solid #3f3f46;'}`;
            btnTabLayers.style.cssText = `flex:1; padding:3px; font-size:11px; border-radius:3px; cursor:pointer; ${currentDrawerTab === 'layers' ? 'background:#3b82f6;color:#fff;border:1px solid #60a5fa;' : 'background:#27272a;color:#a1a1aa;border:1px solid #3f3f46;'}`;
            stickerGrid.style.display = currentDrawerTab === 'lib' ? "grid" : "none";
            layersList.style.display = currentDrawerTab === 'layers' ? "flex" : "none";
        };
        btnTabLib.onclick = () => { currentDrawerTab = "lib"; updateDrawerTabs(); };
        btnTabLayers.onclick = () => { currentDrawerTab = "layers"; updateDrawerTabs(); updateLayersList(); };
        tabsBar.appendChild(btnTabLib); tabsBar.appendChild(btnTabLayers);

        const stickerGrid = document.createElement("div");
        stickerGrid.style.cssText = "flex: 1; overflow-y: auto; display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; align-content: start; padding-right: 2px;";

        const layersList = document.createElement("div");
        layersList.style.cssText = "flex: 1; overflow-y: auto; display: none; flex-direction: column; gap: 4px; padding-right: 2px;";

        stickerDrawer.appendChild(drawerHeader);
        stickerDrawer.appendChild(tabsBar);
        stickerDrawer.appendChild(stickerGrid);
        stickerDrawer.appendChild(layersList);
        container.appendChild(stickerDrawer);

        const loadStickersFromAPI = async () => {
            stickerGrid.innerHTML = "<div style='color:#71717a;font-size:11px;grid-column:span 3;text-align:center;'>Loading stickers...</div>";
            try {
                const res = await fetch("/minimax/stickers");
                const data = await res.json();
                if (data.success && data.stickers) {
                    stickerGrid.innerHTML = "";
                    if (data.stickers.length === 0) {
                        stickerGrid.innerHTML = "<div style='color:#71717a;font-size:11px;grid-column:span 3;text-align:center;padding:12px 4px;'>Library empty<br>Drop PNG into web/stickers/ or click 💾 Save on any sticker</div>";
                        return;
                    }
                    data.stickers.forEach(item => {
                        const card = document.createElement("div");
                        card.style.cssText = "position: relative; aspect-ratio: 1; background: #27272a; border-radius: 4px; border: 1px solid #3f3f46; display: flex; align-items: center; justify-content: center; cursor: pointer; padding: 4px;";
                        card.title = item.name;

                        const img = document.createElement("img");
                        img.src = item.url;
                        img.style.cssText = "max-width: 100%; max-height: 100%; object-fit: contain;";

                        const delBtn = document.createElement("button");
                        delBtn.textContent = "✕";
                        delBtn.title = "Delete from library";
                        delBtn.style.cssText = "position:absolute; top:1px; right:1px; width:14px; height:14px; font-size:9px; line-height:12px; padding:0; background:rgba(127,29,29,0.85); color:#fff; border:none; border-radius:2px; cursor:pointer; display:none;";
                        card.onmouseenter = () => delBtn.style.display = "block";
                        card.onmouseleave = () => delBtn.style.display = "none";
                        delBtn.onclick = async (e) => {
                            e.stopPropagation();
                            if (!confirm(`Delete sticker "${item.name}" from library?`)) return;
                            await fetch("/minimax/stickers/delete", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ filename: item.filename })
                            });
                            loadStickersFromAPI();
                        };

                        card.onclick = () => {
                            const simg = new Image();
                            simg.crossOrigin = "anonymous";
                            simg.onload = () => {
                                saveState();
                                const sw = Math.min(220, simg.width || 180);
                                const sh = ((simg.height || 180) / (simg.width || 180)) * sw;
                                stickers.push({
                                    id: `sticker_${Date.now()}`,
                                    name: item.name,
                                    img: simg,
                                    src: item.url,
                                    x: viewport.x + viewport.w / 2 - sw / 2,
                                    y: viewport.y + viewport.h / 2 - sh / 2,
                                    w: sw, h: sh,
                                    rotation: 0, flipX: false, flipY: false, opacity: 1.0,
                                    visible: true
                                });
                                selectedElement = { type: 'sticker', index: stickers.length - 1 };
                                currentTool = "move";
                                updateToolButtons();
                                rebuildStickerCanvas(); render(); saveLightweightState(); updateLayersList();
                            };
                            simg.src = item.url;
                        };

                        card.appendChild(img);
                        card.appendChild(delBtn);
                        stickerGrid.appendChild(card);
                    });
                }
            } catch (e) {
                stickerGrid.innerHTML = "<div style='color:#ef4444;font-size:11px;grid-column:span 3;text-align:center;'>Failed to load library</div>";
            }
        };

        const updateLayersList = () => {
            layersList.innerHTML = "";
            if (stickers.length === 0) {
                layersList.innerHTML = "<div style='color:#71717a;font-size:11px;text-align:center;padding:10px;'>No active sticker layers</div>";
                return;
            }

            for (let i = stickers.length - 1; i >= 0; i--) {
                const st = stickers[i];
                const row = document.createElement("div");
                row.style.cssText = `display:flex; align-items:center; gap:6px; padding:4px 6px; border-radius:4px; font-size:11px; cursor:pointer; ${selectedElement?.type === 'sticker' && selectedElement.index === i ? 'background:#3b82f6;color:#fff;' : 'background:#27272a;color:#d4d4d8;'}`;

                const btnVis = document.createElement("button");
                btnVis.textContent = st.visible !== false ? "👁️" : "🕶️";
                btnVis.style.cssText = "background:transparent; border:none; cursor:pointer; font-size:11px; padding:0;";
                btnVis.onclick = (e) => {
                    e.stopPropagation();
                    st.visible = st.visible === false ? true : false;
                    btnVis.textContent = st.visible ? "👁️" : "🕶️";
                    rebuildStickerCanvas(); render(); saveLightweightState();
                };

                const nameSpan = document.createElement("span");
                nameSpan.textContent = st.name || `Sticker ${i + 1}`;
                nameSpan.style.cssText = "flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";

                row.onclick = () => {
                    selectedElement = { type: 'sticker', index: i };
                    currentTool = "move";
                    updateToolButtons();
                    render(); updateLayersList();
                };

                row.appendChild(btnVis);
                row.appendChild(nameSpan);
                layersList.appendChild(row);
            }
        };

        // =================================================================
        // UI Main Controls (All in English)
        // =================================================================
        const toolBar = document.createElement("div");
        toolBar.style.cssText = "display: flex; gap: 3px; align-items: center; flex-wrap: wrap; background: #27272a; padding: 4px; border-radius: 4px;";

        const tools = [
            { id: "move", label: "↖️ Move" },
            { id: "brush", label: "✏️ Pen" },
            { id: "eraser", label: "🧹 Eraser" },
            { id: "line", label: "📏 Line" },
            { id: "arrow", label: "➡️ Arrow" },
            { id: "rect", label: "🔲 Rect" },
            { id: "ellipse", label: "⭕ Circle" },
            { id: "text", label: "🔤 Text" }
        ];

        const toolBtns = {};
        tools.forEach(t => {
            const b = document.createElement("button");
            b.textContent = t.label; b.title = t.id;
            b.style.cssText = "padding: 3px 6px; background: #3f3f46; color: #f4f4f5; border: 1px solid #52525b; border-radius: 3px; cursor: pointer; font-size: 11px;";
            b.onclick = () => {
                currentTool = t.id;
                isPanMode = false;
                updateToolButtons();
                canvas.style.cursor = currentTool === "move" ? "default" : "crosshair";
            };
            toolBtns[t.id] = b; toolBar.appendChild(b);
        });

        const btnFill = document.createElement("button");
        btnFill.textContent = "Fill: Off";
        btnFill.style.cssText = "padding: 3px 6px; background: #3f3f46; color: #a1a1aa; border: 1px solid #52525b; border-radius: 3px; cursor: pointer; font-size: 11px;";
        btnFill.onclick = () => {
            isFilled = !isFilled;
            btnFill.textContent = isFilled ? "Fill: On" : "Fill: Off";
            btnFill.style.color = isFilled ? "#38bdf8" : "#a1a1aa";
        };
        toolBar.appendChild(btnFill);

        const btnOpenDrawer = document.createElement("button");
        btnOpenDrawer.textContent = "⭐ Stickers";
        btnOpenDrawer.style.cssText = "padding: 3px 7px; background: #4f46e5; color: #fff; border: 1px solid #6366f1; border-radius: 3px; cursor: pointer; font-size: 11px; font-weight: 600;";
        btnOpenDrawer.onclick = () => {
            stickerDrawer.style.display = "flex";
            updateDrawerTabs();
            loadStickersFromAPI();
            updateLayersList();
        };
        toolBar.appendChild(btnOpenDrawer);

        const btnRemoveBg = document.createElement("button");
        btnRemoveBg.textContent = "🖼️❌ Clear Bg";
        btnRemoveBg.title = "Remove base image and reset to Chroma Green stage";
        btnRemoveBg.style.cssText = "padding: 3px 6px; background: #451a1a; color: #fca5a5; border: 1px solid #7f1d1d; border-radius: 3px; cursor: pointer; font-size: 11px; margin-left: auto;";
        btnRemoveBg.onclick = removeBackgroundImage;
        toolBar.appendChild(btnRemoveBg);

        const btnResetView = document.createElement("button");
        btnResetView.textContent = "🔍 Center";
        btnResetView.style.cssText = "padding: 3px 6px; background: #3f3f46; color: #f4f4f5; border: 1px solid #52525b; border-radius: 3px; cursor: pointer; font-size: 11px;";
        btnResetView.onclick = () => { viewScale = 1.0; viewPan = { x: 0, y: 0 }; render(); };
        toolBar.appendChild(btnResetView);

        const updateToolButtons = () => {
            tools.forEach(t => {
                if (toolBtns[t.id]) {
                    toolBtns[t.id].style.background = currentTool === t.id ? "#2563eb" : "#3f3f46";
                    toolBtns[t.id].style.color = currentTool === t.id ? "#fff" : "#f4f4f5";
                    toolBtns[t.id].style.borderColor = currentTool === t.id ? "#60a5fa" : "#52525b";
                }
            });
        };
        updateToolButtons();

        // Tag bar
        const tagBar = document.createElement("div");
        tagBar.style.cssText = "display: flex; gap: 4px; align-items: center; justify-content: space-between;";

        const tagGroup = document.createElement("div");
        tagGroup.style.cssText = "display: flex; gap: 4px;";

        const btnAddSTag = document.createElement("button");
        btnAddSTag.textContent = "🏷️ S Subject";
        btnAddSTag.style.cssText = "padding: 3px 7px; background: #3f3f46; color: #fff; border: 1px solid #52525b; border-radius: 3px; cursor: pointer; font-size: 11px;";
        btnAddSTag.onclick = () => {
            saveState(); sTags.push({ id: getNextAvailableId("S", sTags), x: viewport.x + viewport.w / 2, y: viewport.y + viewport.h / 2 });
            render(); saveLightweightState();
        };

        const btnAddATag = document.createElement("button");
        btnAddATag.textContent = "🎬 A Action";
        btnAddATag.style.cssText = "padding: 3px 7px; background: #7c3aed; color: #fff; border: 1px solid #8b5cf6; border-radius: 3px; cursor: pointer; font-size: 11px; font-weight: 600;";
        btnAddATag.onclick = () => {
            saveState(); aTags.push({ id: getNextAvailableId("A", aTags), x: viewport.x + viewport.w / 2, y: viewport.y + viewport.h / 2 });
            render(); saveLightweightState();
        };

        const btnAddFrame = document.createElement("button");
        btnAddFrame.textContent = "🎞️ Shot Frame";
        btnAddFrame.style.cssText = "padding: 3px 7px; background: #3f3f46; color: #fff; border: 1px solid #52525b; border-radius: 3px; cursor: pointer; font-size: 11px;";
        btnAddFrame.onclick = () => {
            saveState();
            const fw = viewport.w * 0.7, fh = viewport.h * 0.25;
            frames.push({ id: getNextAvailableId("Shot ", frames), x: viewport.x + (viewport.w - fw) / 2, y: viewport.y + 40 + frames.length * (fh + 25), w: fw, h: fh });
            render(); saveLightweightState();
        };

        tagGroup.appendChild(btnAddSTag); tagGroup.appendChild(btnAddATag); tagGroup.appendChild(btnAddFrame);

        const btnPan = document.createElement("button");
        btnPan.textContent = "✋ Pan";
        btnPan.style.cssText = "padding: 3px 7px; background: #3f3f46; color: #fff; border: 1px solid #52525b; border-radius: 3px; cursor: pointer; font-size: 11px;";
        btnPan.onclick = () => {
            isPanMode = !isPanMode; btnPan.style.background = isPanMode ? "#2563eb" : "#3f3f46";
            canvas.style.cursor = isPanMode ? "grab" : "crosshair";
        };
        tagBar.appendChild(tagGroup); tagBar.appendChild(btnPan);

        // Palette bar
        const paletteBar = document.createElement("div");
        paletteBar.style.cssText = "display: flex; gap: 4px; align-items: center; justify-content: space-between;";
        const paletteColors = document.createElement("div");
        paletteColors.style.cssText = "display: flex; gap: 3px; align-items: center;";
        const curColorBox = document.createElement("div");
        curColorBox.style.cssText = `width: 18px; height: 18px; border-radius: 3px; background: ${currentColor}; border: 2px solid #FFF;`;

        winColors.forEach(hex => {
            const dot = document.createElement("div");
            dot.style.cssText = `width: 14px; height: 14px; border-radius: 2px; background: ${hex}; cursor: pointer; border: 1px solid #000;`;
            dot.onclick = () => { currentColor = hex; curColorBox.style.background = currentColor; if (currentTool === "eraser" || currentTool === "move") currentTool = "brush"; updateToolButtons(); };
            paletteColors.appendChild(dot);
        });

        const colorPicker = document.createElement("input");
        colorPicker.type = "color"; colorPicker.value = currentColor;
        colorPicker.style.cssText = "width: 18px; height: 20px; border: none; background: transparent; cursor: pointer; padding: 0;";
        colorPicker.oninput = (e) => { currentColor = e.target.value; curColorBox.style.background = currentColor; if (currentTool === "eraser" || currentTool === "move") currentTool = "brush"; updateToolButtons(); };
        paletteColors.appendChild(colorPicker);

        const strokeSlider = document.createElement("input");
        strokeSlider.type = "range"; strokeSlider.min = "2"; strokeSlider.max = "36"; strokeSlider.value = brushSize; strokeSlider.style.width = "50px"; strokeSlider.title = "Brush Size";
        strokeSlider.oninput = (e) => brushSize = parseInt(e.target.value, 10);
        paletteBar.appendChild(curColorBox); paletteBar.appendChild(paletteColors); paletteBar.appendChild(strokeSlider);

        // Bottom action bar
        const bottomBar = document.createElement("div");
        bottomBar.style.cssText = "display: flex; gap: 4px; align-items: center; justify-content: flex-end;";

        const btnUndo = document.createElement("button"); btnUndo.textContent = "↩️ Undo";
        btnUndo.style.cssText = "padding: 3px 8px; background: #3f3f46; color: #fff; border: 1px solid #52525b; border-radius: 3px; cursor: pointer; font-size: 11px;"; btnUndo.onclick = undo;
        const btnRedo = document.createElement("button"); btnRedo.textContent = "↪️ Redo";
        btnRedo.style.cssText = "padding: 3px 8px; background: #3f3f46; color: #fff; border: 1px solid #52525b; border-radius: 3px; cursor: pointer; font-size: 11px;"; btnRedo.onclick = redo;
        const btnClear = document.createElement("button"); btnClear.textContent = "🗑️ Clear Annotations";
        btnClear.style.cssText = "padding: 3px 8px; background: #7f1d1d; color: #fecaca; border: 1px solid #991b1b; border-radius: 3px; cursor: pointer; font-size: 11px;";
        btnClear.onclick = () => { saveState(); elements = []; sTags = []; aTags = []; frames = []; rebuildDrawCanvas(); render(); saveLightweightState(); };

        const updateHistoryButtons = () => { btnUndo.style.opacity = undoStack.length > 0 ? "1" : "0.5"; btnRedo.style.opacity = redoStack.length > 0 ? "1" : "0.5"; };
        updateHistoryButtons();

        bottomBar.appendChild(btnUndo); bottomBar.appendChild(btnRedo); bottomBar.appendChild(btnClear);

        container.appendChild(toolBar);
        container.appendChild(canvas);
        container.appendChild(tagBar);
        container.appendChild(paletteBar);
        container.appendChild(bottomBar);

        node.addDOMWidget("canvas_widget", "Canvas", container, { serialize: false });

        // Restore State from Lightweight Properties
        const restoreFromProperties = () => {
            if (node.properties && node.properties["canvas_state"]) {
                try {
                    const state = JSON.parse(node.properties["canvas_state"]);
                    if (state.elements) elements = state.elements;
                    if (state.sTags) sTags = state.sTags;
                    if (state.aTags) aTags = state.aTags;
                    if (state.frames) frames = state.frames;
                    if (state.viewport) viewport = state.viewport;
                    if (state.stagePadding) stagePadding = state.stagePadding;

                    if (state.stickers && state.stickers.length > 0) {
                        stickers = [];
                        state.stickers.forEach(sdata => {
                            const simg = new Image();
                            simg.crossOrigin = "anonymous";
                            simg.onload = () => {
                                stickers.push({ ...sdata, img: simg });
                                rebuildStickerCanvas();
                                render();
                                updateLayersList();
                            };
                            simg.src = sdata.src;
                        });
                    }

                    if (state.uploadedBgFilename) {
                        uploadedBgFilename = state.uploadedBgFilename;
                        const imgUrl = api.apiURL(`/view?filename=${encodeURIComponent(uploadedBgFilename)}&type=input`);
                        const img = new Image();
                        img.crossOrigin = "anonymous";
                        img.onload = () => {
                            uploadedBgImg = img;
                            currentRatioLabel = computeAspectRatio(Math.round(viewport.w), Math.round(viewport.h));
                            updateStageCanvases();
                        };
                        img.src = imgUrl;
                    } else {
                        updateStageCanvases();
                    }
                } catch (e) {
                    console.error("[MiniMax Canvas] Restore error:", e);
                }
            }
        };

        const origOnConfigure = node.onConfigure;
        node.onConfigure = function (info) {
            if (origOnConfigure) origOnConfigure.apply(this, arguments);
            setTimeout(restoreFromProperties, 100);
        };

        node.onResize = () => render();
        node.size = [460, 640];
        setTimeout(render, 100);
    }
});