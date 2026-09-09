(() => {
    "use strict";

    const API_BASE = window.location.protocol === "file:" ? "http://127.0.0.1:8000" : "";
    const DEFAULT_CENTER = { lng: 121.445, lat: 31.205 };
    const PACE_LABELS = { relaxed: "轻松慢逛", normal: "正常节奏", packed: "紧凑多逛" };
    const core = window.CitywalkRouteCore;

    let map = null;
    let currentUserPoint = null;
    let currentStartName = "";
    let currentRoute = [];
    let currentRouteDistance = 0;
    let currentMetrics = null;
    let routeSnapshots = [];
    let initialSnapshot = null;
    let lastActionSummary = "";
    const walkingCache = new Map();
    const resolvedPlaces = new Map();
    let chatHistory = [];
    let tripState = {
        start: null,
        duration_minutes: null,
        theme: [],
        pace: null,
        end: null,
        constraints: [],
        max_walk_meters: null,
        required_places: [],
        excluded_places: [],
        required_categories: []
    };
    let selectedGpsSuggestion = null;
    let gpsDebounceTimer = null;
    let gpsSearchSeq = 0;
    let isBusy = false;
    let activeRequest = null;
    let activeProgress = null;
    let hasInteraction = false;
    let turnChatResponse = null;
    const serviceStatus = document.getElementById("service-status");

    function failureDescription(data) {
        const descriptions = {
            model_timeout: "本次 AI 回复超时", model_network_error: "本次 AI 请求遇到网络波动",
            invalid_model_response: "本次 AI 返回格式异常", model_unavailable: "本次 AI 服务响应异常",
            model_rate_limited: "AI 请求暂时过多", missing_api_key: "尚未配置 AI 密钥",
            model_auth_error: "AI 密钥验证失败", model_quota_exceeded: "AI 账户额度不足",
            model_access_denied: "AI 访问被拒绝", model_not_found: "AI 模型配置有误",
            model_invalid_request: "AI 请求配置有误"
        };
        return descriptions[data?.fallback_reason] || "本次 AI 请求未完成";
    }

    function responseStatus(data, stage = "chat") {
        if (stage === "chat") turnChatResponse = data;
        const chat = turnChatResponse || data;
        const local = chat.source === "rule_based" || chat.fallback_reason === "rule_based";
        let label = local ? "本轮本地处理" : chat.source === "model" ? "AI 已回复" : "本轮备用回复";
        let detail = local ? "这条明确指令由本地规则处理，没有发生 AI 断联。"
            : chat.source === "model" ? (chat.recovered ? "本次自动重试后已收到 AI 回复。" : "本次已收到 AI 回复。")
            : `${failureDescription(chat)}；下一条消息仍会重新尝试 AI。`;
        if (chat.source === "fallback" && !local) {
            const persistent = { missing_api_key: "AI 未配置", model_auth_error: "AI 验证失败", model_quota_exceeded: "AI 额度不足" };
            label = persistent[chat.fallback_reason] || label;
        }
        if (stage === "filter" && data.source !== "model") {
            label += " · 基础筛选";
            detail += ` 地点筛选使用基础规则：${failureDescription(data)}，不代表对话 AI 已断开。`;
        }
        serviceStatus.textContent = label;
        serviceStatus.title = detail;
    }

    async function requestJson(path, options = {}, timeout = 25000) {
        const controller = new AbortController();
        const cancelActive = () => controller.abort();
        const taskSignal = activeRequest?.signal;
        taskSignal?.addEventListener("abort", cancelActive, { once: true });
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            if (taskSignal?.aborted) throw new Error("已取消");
            const response = await fetch(apiUrl(path), { ...options, signal: controller.signal });
            if (!response.ok) throw new Error(`服务响应异常 (${response.status})`);
            return await response.json();
        } finally {
            clearTimeout(timer);
            taskSignal?.removeEventListener("abort", cancelActive);
        }
    }

    function waitForMap(promise) {
        const signal = activeRequest?.signal;
        if (!signal) return promise;
        return new Promise((resolve, reject) => {
            const cancel = () => reject(new DOMException("已取消", "AbortError"));
            if (signal.aborted) { cancel(); return; }
            signal.addEventListener("abort", cancel, { once: true });
            promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
        });
    }

    async function checkService() {
        try {
            const health = await requestJson("/api/health", {}, 4000);
            if (!hasInteraction) serviceStatus.textContent = health.ai_configured ? "服务已就绪" : "AI 未配置";
        } catch (_) {
            if (hasInteraction) return;
            serviceStatus.textContent = "服务未连接";
            appendMessage("assistant", "还没有连上本地服务。请双击项目中的“启动 Demo.cmd”，然后打开 http://127.0.0.1:8000。", "error");
        }
    }

    function loadMap() {
        window.citywalkMapReady = () => {
            try { initMap(); } catch (_) {
                routeList.textContent = "地图加载失败，聊天仍可使用";
            }
        };
        const script = document.createElement("script");
        script.src = "https://api.map.baidu.com/api?v=1.0&type=webgl&ak=XS8HdzSDKpKJG7uGCsyuoJ6xCcxSrMwv&callback=citywalkMapReady";
        script.onerror = () => { routeList.textContent = "地图网络不可用，聊天仍可使用"; };
        document.head.appendChild(script);
    }

    const gpsInput = document.getElementById("gps-input");
    const gpsSuggestions = document.getElementById("gps-suggestions");
    const setStartButton = document.getElementById("set-start-btn");
    const routeList = document.getElementById("route-list");
    const routeSummary = document.getElementById("route-summary");
    const aiContext = document.getElementById("ai-context");
    const contextChips = document.getElementById("context-chips");
    const aiInterpretation = document.getElementById("ai-interpretation");
    const chatMessages = document.getElementById("chat-messages");
    const chatInput = document.getElementById("chat-input");
    const sendButton = document.getElementById("send-btn");
    const undoButton = document.getElementById("undo-route-btn");
    const appRoot = document.getElementById("app");
    const routePanel = document.getElementById("panel");
    const panelToggle = document.getElementById("panel-toggle");
    const mobileMapTab = document.getElementById("mobile-map-tab");
    const mobileChatTab = document.getElementById("mobile-chat-tab");

    function isMobileLayout() { return Boolean(window.matchMedia?.("(max-width: 640px), (max-width: 950px) and (max-height: 500px)")?.matches); }

    function setPanelExpanded(expanded) {
        routePanel.dataset.expanded = String(expanded);
        panelToggle?.setAttribute("aria-expanded", String(expanded));
        if (panelToggle) panelToggle.textContent = expanded ? "收起详情" : "展开详情";
    }

    function setMobileView(view) {
        appRoot.dataset.mobileView = view;
        mobileMapTab?.setAttribute("aria-pressed", String(view === "map"));
        mobileChatTab?.setAttribute("aria-pressed", String(view === "chat"));
        if (view === "map" && isMobileLayout()) {
            chatInput.blur?.();
            window.requestAnimationFrame?.(() => {
                if (!map) return;
                if (currentRoute.length) paintRoute(currentRoute, currentMetrics);
                else map.centerAndZoom(currentUserPoint || new BMapGL.Point(DEFAULT_CENTER.lng, DEFAULT_CENTER.lat), 15);
            });
        }
    }

    function syncViewportHeight() {
        const viewport = window.visualViewport;
        if (viewport && viewport.scale === 1 && viewport.height > 0) {
            appRoot.style.setProperty("--app-height", `${viewport.height}px`);
        }
    }

    class RouteError extends Error {}

    function captureSnapshot() {
        return { route: currentRoute.map(stop => ({ ...stop })), state: JSON.parse(JSON.stringify(tripState)),
            point: currentUserPoint, name: currentStartName, distance: currentRouteDistance, metrics: currentMetrics };
    }

    function restoreSnapshot(snapshot, render = true) {
        currentRoute = snapshot.route.map(stop => ({ ...stop }));
        tripState = JSON.parse(JSON.stringify(snapshot.state));
        currentUserPoint = snapshot.point;
        currentStartName = snapshot.name;
        currentRouteDistance = snapshot.distance;
        currentMetrics = snapshot.metrics;
        gpsInput.value = currentStartName;
        if (render) {
            paintRoute(currentRoute, currentMetrics);
            renderRoute(currentRoute, currentRouteDistance);
            renderUnderstanding({ interpretation: currentRoute.length > 1 ? "以下为已生效路线。" : "请告诉我起点、时长和主题。" });
        }
    }

    function apiUrl(path) {
        return `${API_BASE}${path}`;
    }

    function initMap() {
        if (!window.BMapGL) {
            routeList.textContent = "地图暂时没有加载成功，请检查网络后刷新";
            appendMessage("assistant", "地图服务暂时没有加载成功。聊天仍可使用，刷新页面后可以重试地图。", "error");
            return;
        }

        map = new BMapGL.Map("container");
        map.centerAndZoom(new BMapGL.Point(DEFAULT_CENTER.lng, DEFAULT_CENTER.lat), 15);
        map.enableScrollWheelZoom(true);
        try {
            map.setMapStyleV2({ styleId: "6b0a5e0b2bef73dabbbb2b6b5c2b0341" });
        } catch (_) {
            // 自定义地图样式不可用时继续使用默认样式。
        }
    }

    function createMessageShell(role) {
        const row = document.createElement("div");
        row.className = `msg ${role}`;

        const avatar = document.createElement("div");
        avatar.className = "msg-avatar";
        avatar.textContent = role === "assistant" ? "徐" : "我";

        const bubble = document.createElement("div");
        bubble.className = "bubble";

        row.append(avatar, bubble);
        chatMessages.appendChild(row);
        chatMessages.scrollTop = chatMessages.scrollHeight;
        return { row, bubble };
    }

    function appendMessage(role, content, variant = "") {
        const { row, bubble } = createMessageShell(role);
        if (variant) row.dataset.variant = variant;
        bubble.textContent = content || "";
        bubble.style.whiteSpace = "pre-wrap";
        chatMessages.scrollTop = chatMessages.scrollHeight;
        return row;
    }

    function appendPlanningProgress() {
        const { row, bubble } = createMessageShell("assistant");
        const progress = document.createElement("div");
        progress.className = "ai-progress";
        const labels = ["理解你的需求", "搜索附近地点", "AI 筛选与匹配", "排列步行路线"];
        const nodes = labels.map(label => {
            const node = document.createElement("div");
            node.className = "ai-progress-step";
            node.textContent = `○ ${label}`;
            progress.appendChild(node);
            return node;
        });
        bubble.appendChild(progress);

        return {
            row,
            setStage(index, detail = "") {
                nodes.forEach((node, nodeIndex) => {
                    node.classList.toggle("done", nodeIndex < index);
                    node.classList.toggle("active", nodeIndex === index);
                    const mark = nodeIndex < index ? "✓" : nodeIndex === index ? "●" : "○";
                    node.textContent = `${mark} ${labels[nodeIndex]}${nodeIndex === index && detail ? ` · ${detail}` : ""}`;
                });
                chatMessages.scrollTop = chatMessages.scrollHeight;
            },
            complete() {
                nodes.forEach((node, nodeIndex) => {
                    node.classList.remove("active");
                    node.classList.add("done");
                    node.textContent = `✓ ${labels[nodeIndex]}`;
                });
            },
            fail(message) {
                nodes.forEach(node => node.classList.remove("active"));
                const note = document.createElement("div");
                note.className = "theme-note";
                note.textContent = message;
                progress.appendChild(note);
            }
        };
    }

    function setBusy(value) {
        isBusy = value;
        setStartButton.disabled = value;
        sendButton.disabled = false;
        sendButton.setAttribute("aria-label", value ? "停止等待" : "发送");
        sendButton.title = value ? "停止等待" : "发送";
        sendButton.setAttribute("aria-busy", String(value));
        chatInput.placeholder = value ? "正在处理，可点击右侧方块停止等待" : "问问小徐：这附近有什么好吃的？";
        document.querySelectorAll(".quick-prompt").forEach(button => { button.disabled = value; });
        if (undoButton) undoButton.disabled = value || !routeSnapshots.length;
        if (mobileChatTab) mobileChatTab.textContent = value ? "对话 · 处理中" : "对话";
    }

    function renderUnderstanding(data) {
        if (data.trip_state) {
            tripState = {
                ...tripState,
                ...data.trip_state,
                theme: Array.isArray(data.trip_state.theme) ? data.trip_state.theme : tripState.theme,
                constraints: Array.isArray(data.trip_state.constraints) ? data.trip_state.constraints : tripState.constraints
            };
        }

        if (currentStartName && !tripState.start) tripState.start = currentStartName;

        const chips = [];
        if (tripState.start) chips.push(`起点 · ${tripState.start}`);
        if (tripState.duration_minutes) chips.push(`目标时长 · ${formatDuration(tripState.duration_minutes)}`);
        if (tripState.theme?.length) chips.push(`主题 · ${tripState.theme.join(" / ")}`);
        if (tripState.pace) chips.push(`节奏 · ${PACE_LABELS[tripState.pace] || tripState.pace}`);
        if (tripState.end) chips.push(`终点 · ${tripState.end}`);
        if (tripState.max_walk_meters) chips.push(`步行上限 · ${tripState.max_walk_meters} 米`);
        if (tripState.required_categories?.length) chips.push(`必须有 · ${tripState.required_categories.join(" / ")}`);
        if (tripState.excluded_places?.length) chips.push(`不去 · ${tripState.excluded_places.join(" / ")}`);

        contextChips.replaceChildren();
        chips.forEach(text => {
            const chip = document.createElement("span");
            chip.className = "context-chip";
            chip.textContent = text;
            contextChips.appendChild(chip);
        });

        aiInterpretation.textContent = data.interpretation || "";
        aiContext.classList.toggle("visible", chips.length > 0 || Boolean(data.interpretation));
    }

    function formatDuration(minutes) {
        if (!minutes) return "未设置";
        if (minutes < 60) return `${minutes} 分钟`;
        const hours = Math.floor(minutes / 60);
        const rest = minutes % 60;
        return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
    }

    function showGpsSuggestionMessage(message) {
        gpsSuggestions.replaceChildren();
        const item = document.createElement("div");
        item.className = "gps-suggestion-empty";
        item.textContent = message;
        gpsSuggestions.appendChild(item);
        gpsSuggestions.style.display = "block";
    }

    function hideGpsSuggestions() {
        gpsSuggestions.style.display = "none";
        gpsSuggestions.replaceChildren();
    }

    function formatPoiAddress(poi) {
        return [poi.province, poi.city, poi.address]
            .filter(Boolean)
            .map(part => String(part).trim())
            .filter(Boolean)
            .join(" ") || "暂无详细地址";
    }

    function renderGpsSuggestions(pois) {
        if (isMobileLayout()) { setMobileView("map"); setPanelExpanded(true); }
        gpsSuggestions.replaceChildren();
        if (!pois.length) {
            showGpsSuggestionMessage("没有找到匹配地点，请输入更具体的地标");
            return;
        }

        pois.forEach(poi => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "gps-suggestion";
            const name = document.createElement("span");
            name.className = "poi-name";
            name.textContent = poi.title;
            const address = document.createElement("span");
            address.className = "poi-address";
            address.textContent = formatPoiAddress(poi);
            button.append(name, address);
            button.addEventListener("mousedown", event => event.preventDefault());
            button.addEventListener("click", () => {
                selectedGpsSuggestion = poi;
                setStartPoint(poi.point, poi.title, formatPoiAddress(poi));
                hideGpsSuggestions();
            });
            gpsSuggestions.appendChild(button);
        });
        gpsSuggestions.style.display = "block";
    }

    function requestGpsSuggestions(keyword) {
        const query = keyword.trim();
        selectedGpsSuggestion = null;
        if (!query || !map) {
            hideGpsSuggestions();
            return;
        }

        const seq = ++gpsSearchSeq;
        showGpsSuggestionMessage("正在搜索候选地点…");
        const local = new BMapGL.LocalSearch("上海市", {
            pageCapacity: 8,
            onSearchComplete(result) {
                if (seq !== gpsSearchSeq) return;
                const pois = [];
                if (local.getStatus() === BMAP_STATUS_SUCCESS && result) {
                    for (let i = 0; i < result.getCurrentNumPois(); i += 1) {
                        const poi = result.getPoi(i);
                        if (poi?.title && core.inDemoArea(poi?.point)) pois.push(poi);
                    }
                }
                renderGpsSuggestions(pois);
            }
        });
        local.search(query);
    }

    function geocodeAddress(address) {
        // Never accept a fuzzy geocode silently: verify named POIs in the demo area.
        return new Promise(resolve => {
            if (!map || !address) return resolve(null);
            const timeout = setTimeout(() => resolve(null), 8000);
            if (!BMapGL.LocalSearch) { clearTimeout(timeout); return resolve(null); }
            const anchors = { 衡山路: "衡山路地铁站", 徐家汇: "徐家汇地铁站" };
            const query = anchors[core.normalizeName(address)] || address;
            const search = new BMapGL.LocalSearch("上海市", {
                pageCapacity: 10,
                onSearchComplete(result) {
                    clearTimeout(timeout);
                    const candidates = [];
                    if (search.getStatus() === BMAP_STATUS_SUCCESS && result) {
                        for (let i = 0; i < result.getCurrentNumPois(); i += 1) {
                            const poi = result.getPoi(i);
                            const baseTitle = poi?.title?.replace(/[（(].*?[）)]/g, "") || "";
                            const stationMatch = query.endsWith("地铁站") && /地铁/.test(poi?.address || "")
                                && core.normalizeName(poi.title) === core.normalizeName(query.replace(/地铁站$/, ""));
                            if (core.inDemoArea(poi?.point) && (stationMatch || core.samePlace(poi.title, query)
                                || core.normalizeName(baseTitle) === core.normalizeName(query))) candidates.push(poi);
                        }
                    }
                    const stations = candidates.filter(poi => query.endsWith("地铁站") && /地铁/.test(poi.address || "")
                        && core.normalizeName(poi.title) === core.normalizeName(query.replace(/地铁站$/, "")));
                    const exact = stations.length ? stations : candidates.filter(poi => core.normalizeName(poi.title) === core.normalizeName(query));
                    const matches = exact.length ? exact : candidates;
                    // Nearby subway exits are one location; branches far apart need a choice.
                    if (matches.length && matches.every(poi => haversineDistance(matches[0].point, poi.point) < 250)) {
                        resolvedPlaces.set(address, matches[0]);
                        resolve(matches[0].point);
                    } else {
                        if (matches.length) renderGpsSuggestions(matches);
                        resolve(null);
                    }
                }
            });
            search.search(query);
        });
    }

    function addStartMarker() {
        if (!map || !currentUserPoint) return;
        const marker = new BMapGL.Marker(currentUserPoint);
        const label = new BMapGL.Label("起点", { offset: new BMapGL.Size(15, -18) });
        label.setStyle({
            color: "#0a1628",
            backgroundColor: "#4facfe",
            border: "none",
            borderRadius: "5px",
            padding: "4px 8px",
            fontSize: "12px"
        });
        marker.setLabel(label);
        map.addOverlay(marker);
    }

    async function setStartPoint(point, name, detailAddress = "") {
        if (!point || !map || isBusy || !core.inDemoArea(point)) return false;
        const before = captureSnapshot();
        currentUserPoint = point;
        currentStartName = name;
        selectedGpsSuggestion = selectedGpsSuggestion?.title === name ? selectedGpsSuggestion : null;
        gpsInput.value = name;
        tripState.start = name;

        if (currentRoute.length > 1) {
            setBusy(true);
            try {
                await publishRoute([{ name, point, isStart: true, detailAddress }, ...currentRoute.slice(1)], false);
                routeSnapshots.push(before);
                appendMessage("assistant", `起点已改为${name}，其他地点保持不变。`);
            } catch (error) {
                restoreSnapshot(before);
                appendMessage("assistant", `没有更改起点：${error.message}。原路线保留。`);
            } finally { setBusy(false); }
        } else {
            map.clearOverlays();
            addStartMarker();
            map.panTo(point);
            routeList.replaceChildren();
            const item = document.createElement("li");
            item.className = "start-point";
            item.textContent = `📍 起点：${name}${detailAddress && detailAddress !== "暂无详细地址" ? `｜${detailAddress}` : ""}`;
            routeList.appendChild(item);
            routeSummary.classList.remove("visible");
        }
        renderUnderstanding({ trip_state: tripState, interpretation: "起点已确认，可以直接告诉我想怎么逛。" });
        return true;
    }

    async function setStartFromInput() {
        if (isBusy) return;
        const address = gpsInput.value.trim();
        if (!address) {
            appendMessage("assistant", "请先输入一个具体起点，例如“上海图书馆”。");
            return;
        }
        if (selectedGpsSuggestion?.title === address) {
            await setStartPoint(selectedGpsSuggestion.point, selectedGpsSuggestion.title, formatPoiAddress(selectedGpsSuggestion));
            return;
        }
        hideGpsSuggestions();
        setStartButton.disabled = true;
        const point = await geocodeAddress(address);
        setStartButton.disabled = false;
        if (!point) {
            appendMessage("assistant", `我还没找到“${address}”，试试输入更具体的上海地标。`);
            return;
        }
        await setStartPoint(point, address);
    }

    async function ensureStartPoint() {
        const proposedStart = tripState.start || gpsInput.value.trim();
        if (currentUserPoint && proposedStart === currentStartName && core.inDemoArea(currentUserPoint)) return true;
        if (!proposedStart) {
            if (isMobileLayout()) setMobileView("chat");
            appendMessage("assistant", "还差一个起点。你可以直接说“从上海图书馆出发”，或者在地图左上角设置起点。", "needs-input");
            return false;
        }
        const point = await waitForMap(geocodeAddress(proposedStart));
        if (!point) {
            throw new RouteError(`未能唯一确认“${proposedStart}”在徐汇 Demo 覆盖范围内的位置。请在左上角搜索并选择带地址的候选地点`);
        }
        currentUserPoint = point;
        currentStartName = proposedStart;
        return true;
    }

    function haversineDistance(p1, p2) {
        const R = 6371000;
        const toRad = value => value * Math.PI / 180;
        const dLat = toRad(p2.lat - p1.lat);
        const dLng = toRad(p2.lng - p1.lng);
        const a = Math.sin(dLat / 2) ** 2
            + Math.cos(toRad(p1.lat)) * Math.cos(toRad(p2.lat))
            * Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function searchOneKeyword(keyword, radius, center = currentUserPoint) {
        return new Promise(resolve => {
            if (!map || !currentUserPoint) return resolve([]);
            let settled = false;
            const finish = value => {
                if (settled) return;
                settled = true;
                resolve(value);
            };
            const local = new BMapGL.LocalSearch(map, {
                pageCapacity: 10,
                onSearchComplete(result) {
                    const found = [];
                    if (local.getStatus() === BMAP_STATUS_SUCCESS && result) {
                        for (let i = 0; i < result.getCurrentNumPois(); i += 1) {
                            const poi = result.getPoi(i);
                            if (poi?.point && poi?.title && core.isUsablePoi(poi)
                                && haversineDistance(center, poi.point) <= radius) {
                                found.push({
                                    name: poi.title,
                                    point: poi.point,
                                    address: formatPoiAddress(poi),
                                    tags: poi.tags,
                                    category: poi.category,
                                    categories: poi.categories,
                                    type: poi.type,
                                    keyword
                                });
                            }
                        }
                    }
                    finish(found);
                }
            });
            local.searchNearby(keyword, center, radius);
            window.setTimeout(() => finish([]), 9000);
        });
    }

    function resolveCatalogPlace(entry, radius) {
        return new Promise(resolve => {
            if (!map || !currentUserPoint) return resolve(null);
            let settled = false;
            const finish = value => { if (!settled) { settled = true; resolve(value); } };
            const timer = setTimeout(() => finish(null), 6500);
            const search = new BMapGL.LocalSearch("上海市", {
                pageCapacity: 10,
                onSearchComplete(result) {
                    clearTimeout(timer);
                    const matches = [];
                    if (search.getStatus() === BMAP_STATUS_SUCCESS && result) {
                        for (let index = 0; index < result.getCurrentNumPois(); index += 1) {
                            const poi = result.getPoi(index);
                            if (core.matchesCatalogPlace(poi, entry) && core.isUsablePoi(poi)
                                && haversineDistance(currentUserPoint, poi.point) <= radius) matches.push(poi);
                        }
                    }
                    if (!matches.length || matches.some(poi => haversineDistance(matches[0].point, poi.point) > 150)) return finish(null);
                    const poi = matches[0];
                    finish({ name: poi.title, point: poi.point, address: formatPoiAddress(poi),
                        tags: entry.tags, catalog: entry, keyword: "地点库" });
                }
            });
            search.search(entry.name);
        });
    }

    async function searchCatalog(keywords, radius, originalMessage, progress) {
        try {
            const query = [...keywords, ...(tripState.theme || []), originalMessage].filter(Boolean).join(" ");
            const data = await requestJson(`/api/places/search?query=${encodeURIComponent(query)}&limit=8`, {}, 4000);
            const entries = Array.isArray(data.places) ? data.places.slice(0, 8) : [];
            if (!entries.length) return [];
            progress.setStage(1, `地点库命中 ${entries.length} 个，正在地图核对名称和地址`);
            const found = await waitForMap(Promise.all(entries.map(entry => resolveCatalogPlace(entry, radius))));
            return found.filter(Boolean).map(poi => ({ ...poi,
                keyword: keywords.find(keyword => core.categoryMatches(poi, keyword)) || keywords[0] || "地点库" }));
        } catch (_) {
            if (activeRequest?.signal.aborted) throw new DOMException("已取消", "AbortError");
            // Catalog retrieval is local, and must never change the AI connection label.
            return [];
        }
    }

    async function searchPois(keywords, progress, originalMessage = "") {
        const duration = tripState.duration_minutes || 120;
        const radius = Math.min(tripState.max_walk_meters || Infinity, duration <= 60 ? 2000 : duration <= 120 ? 3500 : 5000);
        let allPois = await searchCatalog(keywords, radius, originalMessage, progress);
        for (let index = 0; index < keywords.length; index += 1) {
            progress.setStage(1, `${index + 1}/${keywords.length} · ${keywords[index]}`);
            const pois = await waitForMap(searchOneKeyword(keywords[index], radius));
            allPois = allPois.concat(pois);
        }
        const seen = [];
        return allPois.filter(poi => {
            const baseName = poi.name.replace(/[（(].*?[）)]/g, "");
            if (core.normalizeName(baseName) === core.normalizeName(currentStartName)
                && haversineDistance(currentUserPoint, poi.point) < 100) return false;
            if (seen.some(previous => core.normalizeName(previous.name) === core.normalizeName(poi.name)
                || (previous.catalog && core.matchesCatalogPlace(poi, previous.catalog)))) return false;
            seen.push(poi);
            return true;
        });
    }

    async function filterPois(pois, originalMessage) {
        if (!pois.length) return [];
        const removeObviousNonDestinations = items => {
            const excluded = /(有限公司|软件科技|物业|停车场|加油站|银行|医院|诊所|房产|培训|瑜伽馆|办事处|写字楼)/;
            return items.filter(item => !excluded.test(item.name) && core.isUsablePoi(item)
                && !(tripState.excluded_places || []).some(term => core.samePlace(item.name, term) || core.categoryMatches(item, term)));
        };
        try {
            const data = await requestJson("/api/filter_pois", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    poi_names: pois.map(poi => poi.name),
                    user_message: originalMessage,
                    history: chatHistory.slice(-10)
                })
            });
            responseStatus(data, "filter");
            if (!Array.isArray(data.filtered_names)) return removeObviousNonDestinations(pois);
            const keep = new Set(data.filtered_names);
            const requiredCategories = [...(tripState.required_categories || []),
                ...(tripState.theme || []).filter(theme => /^(咖啡|咖啡馆|书店|花园|公园)$/.test(theme))];
            // Model ranking cannot silently discard every verified bookstore or garden.
            return removeObviousNonDestinations(pois.filter(poi => keep.has(poi.name)
                || requiredCategories.some(category => core.categoryMatches(poi, category))));
        } catch (_) {
            if (activeRequest?.signal.aborted) throw new DOMException("已取消", "AbortError");
            responseStatus({ source: "fallback", fallback_reason: "model_network_error" }, "filter");
            return removeObviousNonDestinations(pois);
        }
    }

    function buildRoute(pois, keywords) {
        const duration = tripState.duration_minutes || 120;
        let maxStops = duration <= 60 ? 3 : duration <= 120 ? 4 : 5;
        if (tripState.pace === "relaxed") maxStops = Math.max(2, maxStops - 1);
        if (tripState.pace === "packed") maxStops = Math.min(5, maxStops + 1);
        const maxDistance = Math.min(tripState.max_walk_meters || Infinity, duration * 45);

        const chosen = [];
        const preferCatalogThenDistance = (a, b) => Number(Boolean(b.catalog)) - Number(Boolean(a.catalog))
            || haversineDistance(currentUserPoint, a.point) - haversineDistance(currentUserPoint, b.point);
        const buckets = keywords.map(keyword => pois
            .filter(poi => poi.keyword === keyword)
            .sort(preferCatalogThenDistance));

        // 按主题轮流取点，避免“老洋房 + 咖啡”最后全是咖啡店。
        while (chosen.length < maxStops && buckets.some(bucket => bucket.length)) {
            let addedThisRound = false;
            for (const bucket of buckets) {
                const match = bucket.find(poi => !chosen.includes(poi));
                if (match && chosen.length < maxStops) {
                    chosen.push(match);
                    addedThisRound = true;
                }
            }
            if (!addedThisRound) break;
        }

        pois
            .filter(poi => !chosen.includes(poi))
            .sort(preferCatalogThenDistance)
            .slice(0, Math.max(0, maxStops - chosen.length))
            .forEach(poi => chosen.push(poi));

        const ordered = [];
        const remaining = [...chosen];
        let cursor = currentUserPoint;
        let approximateDistance = 0;
        while (remaining.length) {
            remaining.sort((a, b) => haversineDistance(cursor, a.point) - haversineDistance(cursor, b.point));
            const next = remaining.shift();
            const legDistance = haversineDistance(cursor, next.point);
            if (approximateDistance + legDistance > maxDistance) continue;
            approximateDistance += legDistance;
            ordered.push(next);
            cursor = next.point;
        }

        return [
            { name: currentStartName || tripState.start || "我的起点", point: currentUserPoint, isStart: true },
            ...ordered.map(poi => ({
                ...poi,
                reason: poi.catalog ? `地点库标签：${poi.catalog.tags.filter(tag => /[\u4e00-\u9fff]/.test(tag)).slice(0, 3).join("、")}；名称与地址已由地图核对。`
                    : `按“${poi.keyword || keywords[0]}”检索，并且与前后地点步行衔接较顺。`
            }))
        ];
    }

    function walkingPathBetween(start, end) {
        const key = `${start.lng},${start.lat}>${end.lng},${end.lat}`;
        if (walkingCache.has(key)) return Promise.resolve(walkingCache.get(key));
        return new Promise(resolve => {
            if (!map) return resolve(null);
            let settled = false;
            const finish = leg => {
                if (settled) return;
                settled = true;
                if (leg) walkingCache.set(key, leg);
                resolve(leg);
            };
            const walk = new BMapGL.WalkingRoute(map);
            walk.setSearchCompleteCallback(result => {
                if (walk.getStatus() === BMAP_STATUS_SUCCESS && result?.getPlan(0)) {
                    const plan = result.getPlan(0);
                    const path = plan.getRoute(0)?.getPath?.() || [];
                    const distance = Number(plan.getDistance(false));
                    const seconds = Number(plan.getDuration(false));
                    finish(path.length && Number.isFinite(distance) && Number.isFinite(seconds)
                        ? { path, distance, walkingMinutes: seconds / 60 } : null);
                } else {
                    finish(null);
                }
            });
            walk.search(start, end);
            window.setTimeout(() => finish(null), 9000);
        });
    }

    async function measureRoute(route) {
        const metrics = { path: [], distance: 0, walkingMinutes: 0, verified: true };
        for (let index = 0; index < route.length - 1; index += 1) {
            const leg = await waitForMap(walkingPathBetween(route[index].point, route[index + 1].point));
            if (!leg) throw new RouteError("地图暂时没有返回可核验的步行路线，请稍后重试；不会用直线距离冒充步行距离");
            metrics.path.push(...leg.path);
            metrics.distance += leg.distance;
            metrics.walkingMinutes += leg.walkingMinutes;
        }
        return metrics;
    }

    function paintRoute(route, metrics) {
        if (!map) return;
        map.clearOverlays();
        addStartMarker();
        const fullPath = metrics?.path || [];

        if (fullPath.length > 1) {
            map.addOverlay(new BMapGL.Polyline(fullPath, {
                strokeColor: "#4facfe",
                strokeWeight: 5,
                strokeOpacity: 0.85
            }));
        }

        route.slice(1).forEach((stop, index) => {
            const marker = new BMapGL.Marker(stop.point);
            const label = new BMapGL.Label(`${index + 1}. ${stop.name}`, { offset: new BMapGL.Size(15, -25) });
            label.setStyle({
                color: "#fff",
                backgroundColor: "#e74c3c",
                border: "none",
                borderRadius: "6px",
                padding: "5px 9px",
                fontSize: "12px"
            });
            marker.setLabel(label);
            marker.addEventListener("click", () => askAboutPlace(stop));
            map.addOverlay(marker);
        });

        const viewportPoints = fullPath.length ? fullPath : route.map(item => item.point);
        if (viewportPoints.length) map.setViewport(viewportPoints, { margins: [55, 55, 55, 55] });
    }

    function protectedStop(stop, route = currentRoute) {
        return stop.isEnd || (tripState.required_places || []).some(name => core.samePlace(stop.name, name))
            || [...(tripState.required_categories || []), ...(tripState.theme || []).filter(theme => /^(咖啡|咖啡馆|书店|花园|公园)$/.test(theme))]
                .some(category => core.categoryMatches(stop, category)
                && !route.some(other => !other.isStart && !core.samePlace(other.name, stop.name) && core.categoryMatches(other, category)));
    }

    async function publishRoute(proposed, allowTrim = false) {
        let route = proposed.map((stop, index) => ({ ...stop,
            isEnd: Boolean(index > 0 && tripState.end && core.samePlace(stop.name, tripState.end)) }));
        if (route.length <= 1) throw new RouteError("没有找到满足条件的游览地点，可以换主题或放宽距离");
        let metrics = await measureRoute(route);
        let violations = core.validateRoute(route, tripState, metrics);
        while (allowTrim && violations.length && route.length > 2) {
            const removable = route.map((stop, index) => ({ stop, index }))
                .filter(({ stop, index }) => index > 0 && !protectedStop(stop, route));
            if (!removable.length) break;
            route.splice(removable.at(-1).index, 1);
            metrics = await measureRoute(route);
            violations = core.validateRoute(route, tripState, metrics);
        }
        if (violations.length) throw new RouteError(violations.join("；"));
        if (activeRequest?.signal.aborted) throw new DOMException("已取消", "AbortError");
        currentRoute = route;
        currentMetrics = metrics;
        currentRouteDistance = metrics.distance;
        currentUserPoint = route[0].point;
        currentStartName = route[0].name;
        tripState.start = currentStartName;
        gpsInput.value = currentStartName;
        paintRoute(route, metrics);
        renderRoute(route, metrics.distance);
        renderUnderstanding({ interpretation: "路线已校验并生效；开放时间请以场馆公告为准。" });
        lastActionSummary = `已生效：从${currentStartName}出发，${route.slice(1).map(stop => stop.name).join(" → ")}。步行约${Math.ceil(metrics.distance)}米。`;
        if (isMobileLayout()) { setPanelExpanded(false); setMobileView("map"); }
        return true;
    }

    function renderRoute(route, distance) {
        routeList.replaceChildren();
        if (!route.length) {
            document.getElementById("panel-title").textContent = "📍 起点与路线";
            routeList.textContent = "尚无已生效路线，请告诉我起点、时长和主题。";
            routeSummary.classList.remove("visible");
            return;
        }
        route.forEach((stop, index) => {
            const item = document.createElement("li");
            if (stop.isStart) {
                item.className = "start-point";
                item.textContent = `📍 起点：${stop.name}`;
            } else {
                item.className = "route-stop";
                const name = document.createElement("span");
                name.className = "route-stop-name";
                name.textContent = `${index}. ${stop.name}`;
                const reason = document.createElement("span");
                reason.className = "route-stop-reason";
                reason.textContent = stop.reason || "位于当前路线的合理步行范围内。";
                item.append(name, reason);
                item.addEventListener("click", () => {
                    map?.panTo(stop.point);
                    askAboutPlace(stop);
                });
            }
            routeList.appendChild(item);
        });

        const minutes = Math.ceil((currentMetrics?.walkingMinutes || 0) + core.estimatedVisitMinutes(route, tripState));
        routeSummary.textContent = `步行 ${Math.ceil(distance)} 米 · 含停留预计 ${minutes} 分钟 · ${route.length - 1} 站`;
        document.getElementById("panel-title").textContent = `📍 ${route.length - 1} 站 · 步行 ${Math.ceil(distance)} 米`;
        routeSummary.classList.add("visible");
        document.getElementById("panel").scrollTop = 0;
    }

    function appendRouteResult(route, distance, interpretation) {
        const { bubble } = createMessageShell("assistant");
        const title = document.createElement("strong");
        const minutes = Math.ceil(currentMetrics.walkingMinutes + core.estimatedVisitMinutes(route, tripState));
        title.textContent = `路线已生效：${route.length - 1} 站 · 步行 ${Math.ceil(distance)} 米 · 含停留预计 ${minutes} 分钟`;
        bubble.appendChild(title);
        if (interpretation) {
            const description = document.createElement("div");
            description.className = "theme-note";
            description.textContent = interpretation;
            bubble.appendChild(description);
        }
        route.slice(1).forEach((stop, index) => {
            const line = document.createElement("div");
            line.style.marginTop = "7px";
            line.textContent = `${index + 1}. ${stop.name}：${stop.reason}`;
            bubble.appendChild(line);
            if (stop.catalog?.sources?.length) {
                const source = stop.catalog.sources.find(item => /^https:\/\//.test(item.url));
                if (source) {
                    const link = document.createElement("a");
                    link.textContent = "查看地点资料 ↗";
                    link.href = source.url;
                    link.target = "_blank";
                    link.rel = "noopener noreferrer";
                    link.style.cssText = "display:inline-block;color:#8fcdf5;font-size:12px;padding:5px 0";
                    bubble.appendChild(link);
                }
            }
        });
        const hint = document.createElement("div");
        hint.className = "theme-note";
        hint.textContent = "可继续指定顺序、删改地点，或说“撤销上一步”。停留时间为估算，营业开放信息未核实。";
        bubble.appendChild(hint);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    async function resolveNamedStop(name) {
        const existing = currentRoute.find(stop => !stop.isStart && core.samePlace(stop.name, name));
        if (existing) return { ...existing, isEnd: false };
        const point = await waitForMap(geocodeAddress(name));
        if (!point) throw new RouteError(`无法确认“${name}”的准确位置，请在左上角搜索核对完整名称`);
        const poi = resolvedPlaces.get(name);
        return { name: poi?.title || name, point, address: poi ? formatPoiAddress(poi) : "", tags: poi?.tags,
            category: poi?.category, keyword: "指定地点", reason: "你指定的地点；请现场核实是否开放。" };
    }

    async function planRoute(keywords, originalMessage, interpretation = "") {
        if (!(await ensureStartPoint())) return false;
        if (/(只保留|仅保留|只去)/.test(originalMessage) && tripState.required_places?.length) {
            const exactRoute = [{ name: currentStartName, point: currentUserPoint, isStart: true }];
            for (const name of tripState.required_places) exactRoute.push(await resolveNamedStop(name));
            tripState.theme = [];
            if (tripState.end) await addRouteEnd(exactRoute, tripState.end);
            await publishRoute(exactRoute, false);
            appendRouteResult(currentRoute, currentRouteDistance, "只包含你指定的地点，没有额外加站。");
            return true;
        }
        const usableKeywords = [...new Set([...(tripState.required_categories || []),
            ...(tripState.theme || []).filter(theme => /^(咖啡|咖啡馆|书店|花园|公园)$/.test(theme)),
            ...(Array.isArray(keywords) && keywords.length ? keywords : tripState.theme?.length ? tripState.theme : ["历史建筑", "公园"])])].slice(0, 4);
        const progress = appendPlanningProgress();
        activeProgress = progress;
        progress.setStage(1, usableKeywords.join(" / "));
        const pois = await searchPois(usableKeywords, progress, originalMessage);
        progress.setStage(2, `${pois.length} 个候选 · ${pois.filter(poi => poi.catalog).length} 个来自已核对地点库`);
        const filtered = await filterPois(pois, originalMessage);
        const route = buildRoute(filtered, usableKeywords);
        const mustHave = [...new Set([...(tripState.required_categories || []), ...(tripState.theme || []).filter(theme => /^(咖啡|咖啡馆|书店|花园|公园)$/.test(theme))])];
        for (const category of mustHave) {
            if (route.slice(1).some(stop => core.categoryMatches(stop, category))) continue;
            const candidate = filtered.filter(poi => core.categoryMatches(poi, category))
                .sort((a, b) => haversineDistance(currentUserPoint, a.point) - haversineDistance(currentUserPoint, b.point))[0];
            if (!candidate) throw new RouteError(`附近没有找到可确认的“${category}”地点，请换一个主题或起点`);
            if (!route.some(stop => core.samePlace(stop.name, candidate.name))) route.push({ ...candidate, reason: `满足“${category}”主题。` });
        }
        // Theme coverage is checked for this route, never persisted as a new hard constraint.
        for (const name of tripState.required_places || []) {
            if (!route.some(stop => core.samePlace(stop.name, name))) route.push(await resolveNamedStop(name));
        }
        if (tripState.end && !(await addRouteEnd(route, tripState.end))) throw new RouteError("固定终点未能加入");
        progress.setStage(3, "核对距离、必去与排除条件");
        await publishRoute(route, true);
        progress.complete();
        // Describe the actual committed stops, never the model's unexecuted itinerary.
        appendRouteResult(currentRoute, currentRouteDistance, "按你的主题检索，已检查地点、步行距离和必去条件。");
        return true;
    }

    async function addRouteEnd(route, requestedEnd) {
        if (!requestedEnd) return true;
        const category = /^(?:附近的?|一家|一个|最后|去|喝|吃|逛|安静的?|特色的?)*(咖啡|咖啡馆|咖啡店|餐厅|书店|公园|花园|下午茶)$/.exec(requestedEnd);
        let candidate;
        if (category) {
            const keyword = category[1] === "咖啡" ? "咖啡馆" : category[1];
            const last = route.at(-1);
            const found = await waitForMap(searchOneKeyword(keyword, 1200, last.point));
            candidate = found.filter(poi => core.isUsablePoi(poi) && core.categoryMatches(poi, keyword))
                .sort((a, b) => haversineDistance(last.point, a.point) - haversineDistance(last.point, b.point))[0];
        } else {
            candidate = await resolveNamedStop(requestedEnd);
        }
        if (!candidate) throw new RouteError(`未找到合适的“${requestedEnd}”作为终点`);
        const proposed = route.filter(stop => stop.isStart || !core.samePlace(stop.name, candidate.name))
            .map(stop => ({ ...stop, isEnd: false }));
        proposed.push({ ...candidate, isEnd: true, reason: "你指定的最后一站。" });
        route.splice(0, route.length, ...proposed);
        tripState.end = candidate.name;
        return true;
    }

    function chineseNumberToInt(value) {
        const mapNumbers = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
        return /^\d+$/.test(value) ? Number(value) : mapNumbers[value] || null;
    }

    function routeTargetIndex(target, originalMessage) {
        const text = `${target || ""} ${originalMessage || ""}`;
        const namedIndex = currentRoute.findIndex((stop, index) => index > 0 && (
            text.includes(stop.name) || (target && stop.name.includes(target))
        ));
        if (namedIndex > 0) return namedIndex;
        const match = text.match(/第([一二两三四五六七八九\d]+)站/);
        const parsed = match ? chineseNumberToInt(match[1]) : null;
        if (parsed && parsed < currentRoute.length) return parsed;
        return -1;
    }


    async function applyRouteModification(modification, keywords, originalMessage) {
        const operation = modification?.operation;
        if (operation === "undo" || operation === "restore_initial") {
            const snapshot = operation === "restore_initial" ? initialSnapshot : routeSnapshots.at(-1);
            if (!snapshot) throw new RouteError("还没有可恢复的路线版本");
            restoreSnapshot(snapshot);
            if (operation === "undo") routeSnapshots.pop();
            else routeSnapshots = [];
            lastActionSummary = operation === "restore_initial" ? "已恢复第一次生成的路线、起点和条件。" : "已撤销上一步，路线、起点和条件一起恢复。";
            appendMessage("assistant", lastActionSummary);
            return true;
        }
        if (currentRoute.length <= 1) throw new RouteError("现在还没有可修改的路线，请先告诉我起点、时长和主题");
        if (operation === "extend") return extendRoute(originalMessage);
        if (["replan", "change_theme", "change_start"].includes(operation)) {
            if (operation === "change_start" && modification.value) tripState.start = modification.value;
            return planRoute(keywords?.length ? keywords : tripState.theme, originalMessage);
        }
        let proposed = currentRoute.map(stop => ({ ...stop }));
        let description = "路线已更新。";
        let allowTrim = false;
        if (operation === "change_end") {
            // Clearing a fixed destination keeps the stop itself, as requested.
            proposed = proposed.map(stop => ({ ...stop, isEnd: false,
                reason: stop.isEnd && !modification.value ? "保留这个地点，不再设为固定终点。" : stop.reason }));
            tripState.end = modification.value || null;
            if (tripState.end) await addRouteEnd(proposed, tripState.end);
            description = tripState.end ? `终点已改为“${tripState.end}”。` : "固定终点已取消，其他地点和顺序不变。";
        } else if (operation === "set_stops") {
            if (!modification.places?.length) throw new RouteError("请明确要保留的地点名称");
            proposed = [proposed[0]];
            for (const name of modification.places) proposed.push(await resolveNamedStop(name));
            tripState.required_places = [...modification.places];
            // An exact replacement supersedes previous optional topic coverage.
            tripState.required_categories = [];
            tripState.theme = [];
            if (tripState.end && !modification.places.some(name => core.samePlace(name, tripState.end))) tripState.end = null;
            if (tripState.end) proposed = core.orderStops(proposed, [...modification.places.filter(name => !core.samePlace(name, tripState.end)), tripState.end]);
            description = "已仅保留你指定的地点。";
        } else if (operation === "reorder") {
            if (!modification.places?.length) throw new RouteError("请说出地点顺序，例如“先去第三站，再去第一站”");
            try { proposed = core.orderStops(proposed, modification.places); }
            catch (error) { throw new RouteError(error.message); }
            description = "已按你指定的顺序排列，其他地点没有删减。";
        } else if (operation === "shorten") {
            if (tripState.max_walk_meters) {
                return planRoute(keywords?.length ? keywords : tripState.theme, originalMessage);
            }
            const index = proposed.map((stop, index) => ({ stop, index })).filter(({ stop, index }) => index > 0 && !protectedStop(stop)).at(-1)?.index;
            if (!index || proposed.length <= 2) throw new RouteError("已没有可直接删减的站点，请指定更近的地点或距离上限");
            proposed.splice(index, 1);
            description = "已删减一站，并保留必去地点和固定终点。";
        } else if (operation === "remove_stop") {
            const targets = modification.places?.length ? modification.places : [modification.target];
            for (const target of targets) {
                const index = routeTargetIndex(target, target || originalMessage);
                const actual = proposed.findIndex(stop => !stop.isStart && core.samePlace(stop.name, currentRoute[index]?.name));
                if (actual < 1) throw new RouteError("没能确认要删除哪一站，请使用地点名或第几站");
                const [removed] = proposed.splice(actual, 1);
                tripState.required_places = (tripState.required_places || []).filter(name => !core.samePlace(name, removed.name));
                if (tripState.end && core.samePlace(tripState.end, removed.name)) tripState.end = null;
            }
            description = "已删除指定地点，其他站点保持不变。";
        } else if (operation === "replace_stop" || operation === "add_stop") {
            const index = routeTargetIndex(modification.target, originalMessage);
            if (operation === "replace_stop" && index < 1) throw new RouteError("请明确要替换哪一站");
            const query = modification.value || tripState.theme?.[0] || keywords?.[0];
            if (!query) throw new RouteError("请告诉我要加入的地点或类别");
            const category = /^(?:(?:更?近(?:一点)?|一家|一个|安静|特色|附近)的?)*(咖啡|咖啡馆|咖啡店|书店|花园|公园|历史建筑|老洋房|现代建筑|餐厅)$/.exec(query)?.[1];
            const candidates = category
                ? await waitForMap(searchOneKeyword(category, Math.min(tripState.max_walk_meters || 3500, 3500)))
                : [await resolveNamedStop(query)];
            const available = candidates.filter(poi => core.isUsablePoi(poi) && (!category || core.categoryMatches(poi, category))
                && !proposed.some(stop => core.samePlace(stop.name, poi.name)))
                .sort((a, b) => haversineDistance(currentUserPoint, a.point) - haversineDistance(currentUserPoint, b.point));
            if (!available.length) throw new RouteError("附近没有找到符合条件的新地点，原路线保留");
            const candidate = { ...available[0], reason: `按你的要求加入“${query}”。` };
            if (operation === "replace_stop") {
                const oldName = proposed[index].name;
                tripState.required_places = (tripState.required_places || []).map(name => core.samePlace(name, oldName) ? candidate.name : name);
                if (tripState.end && core.samePlace(tripState.end, oldName)) {
                    tripState.end = candidate.name;
                    candidate.isEnd = true;
                }
                proposed[index] = candidate;
            }
            else proposed.splice(proposed.at(-1).isEnd ? proposed.length - 1 : proposed.length, 0, candidate);
            description = operation === "replace_stop" ? "已替换指定地点，其他站保留。" : "已加入新地点。";
            if (/更近|近一点|少走/.test(originalMessage)) {
                const metrics = await measureRoute(proposed);
                if (metrics.distance >= currentRouteDistance) throw new RouteError("找到的替代地点并没有让路线更短，原路线保留");
            }
        } else {
            throw new RouteError("这项修改暂时无法准确执行，请指定地点或顺序；不会擅自重做整条路线");
        }
        await publishRoute(proposed, allowTrim);
        appendMessage("assistant", `${description}\n${lastActionSummary}`);
        return true;
    }

    async function extendRoute(originalMessage) {
        const beforeDistance = currentRouteDistance;
        const themes = [...new Set([...(tripState.required_categories || []), ...(tripState.theme || [])])];
        const keywords = (themes.length ? themes : ["历史建筑", "公园"]).slice(0, 4);
        const progress = appendPlanningProgress();
        activeProgress = progress;
        progress.setStage(1, "寻找原路线之外的新地点");
        const pois = await searchPois(keywords, progress, originalMessage);
        const candidates = (await filterPois(pois, originalMessage)).filter(poi =>
            !currentRoute.some(stop => core.samePlace(stop.name, poi.name)));
        const insertion = currentRoute.at(-1).isEnd ? currentRoute.length - 1 : currentRoute.length;
        const anchor = currentRoute[insertion - 1].point;
        candidates.sort((a, b) => Number(Boolean(b.catalog)) - Number(Boolean(a.catalog))
            || haversineDistance(anchor, a.point) - haversineDistance(anchor, b.point));
        let constraintReason = "";
        for (const candidate of candidates.slice(0, 8)) {
            progress.setStage(3, `核对新增“${candidate.name}”后的实际距离`);
            const proposed = currentRoute.map(stop => ({ ...stop }));
            proposed.splice(insertion, 0, { ...candidate, reason: "在原路线基础上新增的一站。" });
            let metrics;
            try { metrics = await measureRoute(proposed); }
            catch (error) { if (activeRequest?.signal.aborted) throw error; continue; }
            if (metrics.distance < beforeDistance + 50) continue;
            const violations = core.validateRoute(proposed, tripState, metrics);
            if (violations.length) { constraintReason = violations[0]; continue; }
            await publishRoute(proposed, false);
            progress.complete();
            appendRouteResult(currentRoute, currentRouteDistance,
                `已新增“${candidate.name}”，原有地点和顺序保留。步行从 ${Math.ceil(beforeDistance)} 米延长到 ${Math.ceil(currentRouteDistance)} 米（增加 ${Math.ceil(currentRouteDistance - beforeDistance)} 米）。`);
            return true;
        }
        throw new RouteError(`暂时没有找到符合当前条件、且确实更长的路线。${constraintReason || "附近未找到合适的新地点。"}可以放宽时长或步行上限，再试一次`);
    }

    function askAboutPlace(stop) {
        if (isBusy) return;
        if (isMobileLayout()) setMobileView("chat");
        sendMessage(`介绍一下${stop.name}，并说明它为什么适合我现在这条路线`);
    }

    async function sendMessage(providedText = "") {
        const text = (providedText || chatInput.value).trim();
        if (!text || isBusy) return;
        hasInteraction = true;
        turnChatResponse = null;
        chatInput.value = "";
        appendMessage("user", text);
        const before = captureSnapshot();

        if (currentRoute.length > 1 && /^(撤销(上一步|刚才的修改)?|恢复(到)?(第一次|最初)(的)?路线)[。！!]?$/.test(text)) {
            try {
                await applyRouteModification({ operation: /第一次|最初/.test(text) ? "restore_initial" : "undo" }, [], text);
                chatHistory.push({ role: "user", content: text }, { role: "assistant", content: lastActionSummary });
                responseStatus({ source: "rule_based" });
            } catch (error) { appendMessage("assistant", error.message, "needs-input"); }
            setBusy(false);
            return;
        }
        if (currentRoute.length > 1 && /(路线|一共|全程).*(多久|多长时间|多远|多少公里)/.test(text)) {
            const minutes = Math.ceil(currentMetrics.walkingMinutes + core.estimatedVisitMinutes(currentRoute, tripState));
            const reply = `当前路线共 ${currentRoute.length - 1} 站，地图步行距离 ${Math.ceil(currentRouteDistance)} 米；含停留预计 ${minutes} 分钟（不是保证耗时）。`;
            appendMessage("assistant", reply);
            responseStatus({ source: "rule_based" });
            chatHistory.push({ role: "user", content: text }, { role: "assistant", content: reply });
            return;
        }

        const thinkingRow = appendMessage("assistant", "● 正在理解你的需求…");
        activeRequest = new AbortController();
        setBusy(true);
        serviceStatus.textContent = "本轮处理中…";
        serviceStatus.title = "正在处理这条消息，临时失败会自动重试一次。";
        let actionStarted = false;
        try {
            const data = await requestJson("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    message: text,
                    history: chatHistory.slice(-12),
                    trip_state: tripState,
                    route_places: currentRoute.slice(1).map(stop => stop.name)
                })
            });
            thinkingRow.remove();
            responseStatus(data);
            const action = data.action || data.intent;
            let actionSummary;
            if (action === "plan_route" || action === "modify_route") {
                actionStarted = true;
                tripState = { ...tripState, ...(data.trip_state || {}) };
                for (const field of data.clear_fields || []) {
                    if (field in tripState) tripState[field] = Array.isArray(tripState[field]) ? [] : null;
                }
                // Do not display the model's proposed stop list or premature success.
                appendMessage("assistant", data.source === "fallback" && data.fallback_reason !== "rule_based"
                    ? `${failureDescription(data)}，本轮使用备用处理；我会继续核对地图结果。`
                    : "正在按你的要求核对地点和路线，完成后会告诉你实际改动。");
                const succeeded = action === "plan_route"
                    ? await planRoute(data.keywords, text)
                    : await applyRouteModification(data.modification, data.keywords, text);
                if (!succeeded) {
                    restoreSnapshot(before);
                    actionSummary = "本次没有生成或修改路线，等待补充起点或条件。";
                } else {
                    if (!["undo", "restore_initial"].includes(data.modification?.operation)) {
                        if (before.route.length > 1) routeSnapshots.push(before);
                        routeSnapshots = routeSnapshots.slice(-10);
                        if (!initialSnapshot) initialSnapshot = captureSnapshot();
                    }
                    actionSummary = lastActionSummary;
                }
            } else {
                // A chat reply must never overwrite an already committed route's labels.
                if (!currentRoute.length) renderUnderstanding(data);
                const reply = data.reply || "请告诉我起点、时长和想逛的主题。";
                appendMessage("assistant", data.source === "fallback" && data.fallback_reason !== "rule_based"
                    ? `${failureDescription(data)}，这条先用备用回复，下一条会继续尝试 AI。\n${reply}` : reply);
                actionSummary = reply;
            }
            chatHistory.push({ role: "user", content: text }, { role: "assistant", content: actionSummary });
            chatHistory = chatHistory.slice(-16);
        } catch (error) {
            thinkingRow.remove();
            if (actionStarted) restoreSnapshot(before);
            const cancelled = activeRequest?.signal.aborted;
            if (cancelled) serviceStatus.textContent = "已停止本次请求";
            else if (!actionStarted) serviceStatus.textContent = "本次请求未完成";
            const message = cancelled ? "已停止等待，可以重新发送。原路线没有改变。" : error instanceof RouteError
                ? `这次没有生效：${error.message.replace(/[。；;]+$/, "")}。\n${before.route.length > 1 ? "原路线已保留。你可以调整条件再试。" : "还没有生成路线，请调整条件再试。"}`
                : error.name === "AbortError" ? "这次等待超时了，可以重新发送。原路线没有改变。"
                : actionStarted ? "地图处理暂时失败，本次修改没有生效，原路线已保留。请重试。"
                : "没有连上服务。请双击“启动 Demo.cmd”，再打开 http://127.0.0.1:8000。";
            appendMessage("assistant", message, "error");
            activeProgress?.fail("本次未生效");
            chatHistory.push({ role: "user", content: text }, { role: "assistant", content: message });
            chatHistory = chatHistory.slice(-16);
            if (!chatInput.value && !(error instanceof RouteError)) chatInput.value = text;
        } finally {
            activeRequest = null;
            activeProgress = null;
            setBusy(false);
            if (!isMobileLayout() || appRoot.dataset.mobileView === "chat") chatInput.focus();
        }
    }

    gpsInput.addEventListener("input", () => {
        clearTimeout(gpsDebounceTimer);
        gpsDebounceTimer = setTimeout(() => requestGpsSuggestions(gpsInput.value), 300);
    });
    gpsInput.addEventListener("focus", () => {
        if (gpsInput.value.trim() && !selectedGpsSuggestion) requestGpsSuggestions(gpsInput.value);
    });
    gpsInput.addEventListener("keydown", event => {
        if (event.key === "Enter") {
            event.preventDefault();
            setStartFromInput();
        } else if (event.key === "Escape") {
            hideGpsSuggestions();
        }
    });
    gpsInput.addEventListener("blur", () => setTimeout(hideGpsSuggestions, 150));
    setStartButton.addEventListener("click", setStartFromInput);
    undoButton?.addEventListener("click", () => sendMessage("撤销上一步"));
    panelToggle?.addEventListener("click", () => setPanelExpanded(routePanel.dataset.expanded !== "true"));
    mobileMapTab?.addEventListener("click", () => { setPanelExpanded(false); setMobileView("map"); });
    mobileChatTab?.addEventListener("click", () => setMobileView("chat"));
    document.getElementById("map-chat-button")?.addEventListener("click", () => setMobileView("chat"));
    window.visualViewport?.addEventListener("resize", syncViewportHeight);
    window.addEventListener?.("resize", syncViewportHeight);
    syncViewportHeight();

    chatInput.addEventListener("keydown", event => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            sendMessage();
        }
    });
    sendButton.addEventListener("click", () => {
        if (isBusy) activeRequest?.abort();
        else sendMessage();
    });
    document.querySelectorAll(".quick-prompt").forEach(button => {
        button.addEventListener("click", () => sendMessage(button.textContent));
    });

    checkService();
    loadMap();
})();
